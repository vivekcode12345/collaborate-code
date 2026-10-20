import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Editor } from '@monaco-editor/react';
import { MonacoBinding } from 'y-monaco';

import socket from './socket';
import { createSession } from './yjsProvider';
import { TEMPLATES, LANGUAGES, isDefaultTemplate } from './templates';

import './monacoSetup';
import './App.css';

// Durations the server accepts (ALLOWED_DURATIONS_MIN).
const DURATIONS_MIN = [15, 30, 45, 60, 90];

// Mirrors the server's INTERVIEW_SUBMIT_COOLDOWN_MS (15s) plus a small margin
// so the button is never re-enabled before the server would accept a click.
const SUBMIT_COOLDOWN_MS = 16000;

const VERDICT_TEXT = {
    AC: 'Accepted',
    WA: 'Wrong Answer',
    CE: 'Compile Error',
    RE: 'Runtime Error',
    TLE: 'Time Limit Exceeded',
    IE: 'Internal Error',
    skipped: 'Skipped',
};

// The report endpoint lives on the backend; in dev Vite proxies /api.
const API_BASE = import.meta.env.VITE_SOCKET_URL || '';

const keyName = (kind, roomId) => `interview:${kind}:${roomId}`;

function readStoredKey(kind, roomId) {
    try { return localStorage.getItem(keyName(kind, roomId)); } catch { return null; }
}
function writeStoredKey(kind, roomId, value) {
    try { localStorage.setItem(keyName(kind, roomId), value); } catch { /* private mode */ }
}
function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

const Interview = () => {
    const params = useMemo(() => new URLSearchParams(window.location.search), []);
    const [stage, setStage] = useState('setup'); // 'setup' | 'room'
    const [mode, setMode] = useState(params.get('role') === 'candidate' ? 'candidate' : 'interviewer');
    const [roomId, setRoomId] = useState(params.get('room') || '');
    const [userName, setUserName] = useState(params.get('name') || '');
    const [role, setRole] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const [ivState, setIvState] = useState(null);
    const [submissions, setSubmissions] = useState([]); // interviewer: full detail
    const [results, setResults] = useState([]);        // candidate: sanitized verdicts
    const [rejection, setRejection] = useState('');
    const [ended, setEnded] = useState(null);
    const [report, setReport] = useState(null);
    const [reportError, setReportError] = useState('');

    const [users, setUsers] = useState([]);
    const [language, setLanguage] = useState('javascript');
    const [output, setOutput] = useState('');
    const [running, setRunning] = useState(false);
    const [userInput, setUserInput] = useState('');
    const [copySuccess, setCopySuccess] = useState('');
    const [now, setNow] = useState(() => Date.now());
    const [cooldownUntil, setCooldownUntil] = useState(0);
    const [selectedProblem, setSelectedProblem] = useState('');
    const [selectedDuration, setSelectedDuration] = useState(45);

    const sessionRef = useRef(null);
    const bindingRef = useRef(null);
    const editorRef = useRef(null);
    const joinRef = useRef(null);
    // serverNow - Date.now(): keeps the countdown on the server clock.
    const [clockOffset, setClockOffset] = useState(0);

    // Local ticking clock, used for the countdown and the submit cooldown.
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(t);
    }, []);

    // Server events. Registered on mount, i.e. BEFORE any join is emitted, so
    // the "yjs-init" / "interview-state" replies cannot be missed.
    useEffect(() => {
        const onState = (payload) => {
            if (!payload) return;
            if (typeof payload.serverNow === 'number') {
                // The countdown must use the server clock, not the local one.
                setClockOffset(payload.serverNow - Date.now());
            }
            setIvState(payload);
            if (payload.role) setRole(payload.role);
            if (payload.problem?.id) setSelectedProblem(payload.problem.id);
        };
        const onEnded = (payload) => setEnded(payload || null);
        const onSubmissions = (list) => setSubmissions(Array.isArray(list) ? list : []);
        const onResult = (payload) => {
            if (!payload) return;
            setResults((prev) => [...prev.filter((r) => r.index !== payload.index), payload]);
        };
        const onRejected = (payload) => setRejection(payload?.reason || 'Submission rejected.');
        const onLanguage = (lang) => { if (lang) setLanguage(lang); };
        const onUsers = (list) => setUsers(Array.isArray(list) ? list : []);
        const onCodeRunning = () => { setRunning(true); setOutput('Running...'); };
        const onCodeResponse = (response) => {
            setRunning(false);
            setOutput(response?.run?.output ?? '');
        };
        const onEvicted = (payload) => {
            // Another tab opened this interview with our key and took the role
            // over. The server disconnects this socket next and socket.io does
            // not reconnect after a server-initiated disconnect, so drop back
            // to the setup screen instead of leaving a frozen room behind.
            joinRef.current = null;
            setStage('setup');
            setRole(null);
            setIvState(null);
            setSubmissions([]);
            setResults([]);
            setEnded(null);
            setReport(null);
            setError(payload?.reason || 'This interview was opened in another tab.');
        };
        const onConnect = () => {
            const info = joinRef.current;
            if (!info) return;
            // Re-join after a reconnect: the server replaces our stale socket
            // id and keeps our role (interviewer key / candidate key).
            socket.emit('join-interview', {
                roomId: info.roomId,
                userName: info.userName,
                ...(info.interviewerKey ? { interviewerKey: info.interviewerKey } : {}),
                ...(info.candidateKey ? { candidateKey: info.candidateKey } : {}),
            }, () => {});
        };

        socket.on('interview-state', onState);
        socket.on('interview-ended', onEnded);
        socket.on('interview-submissions', onSubmissions);
        socket.on('submission-result', onResult);
        socket.on('submission-rejected', onRejected);
        socket.on('languageChange', onLanguage);
        socket.on('user-joined', onUsers);
        socket.on('user-Left', onUsers);
        socket.on('codeRunning', onCodeRunning);
        socket.on('codeResponse', onCodeResponse);
        socket.on('connect', onConnect);
        socket.on('interview-evicted', onEvicted);

        return () => {
            socket.off('interview-state', onState);
            socket.off('interview-ended', onEnded);
            socket.off('interview-submissions', onSubmissions);
            socket.off('submission-result', onResult);
            socket.off('submission-rejected', onRejected);
            socket.off('languageChange', onLanguage);
            socket.off('user-joined', onUsers);
            socket.off('user-Left', onUsers);
            socket.off('codeRunning', onCodeRunning);
            socket.off('codeResponse', onCodeResponse);
            socket.off('connect', onConnect);
            socket.off('interview-evicted', onEvicted);
        };
    }, []);

    // Release the room and the Yjs session when leaving the screen.
    useEffect(() => () => {
        socket.emit('leave-room');
        if (bindingRef.current) {
            bindingRef.current.destroy();
            bindingRef.current = null;
        }
        if (sessionRef.current) {
            sessionRef.current.destroy();
            sessionRef.current = null;
        }
    }, []);

    const status = ivState?.status || 'lobby';
    const isInterviewer = role === 'interviewer';
    const isCandidate = role === 'candidate';
    const serverNow = now + clockOffset;
    const remainingMs = ivState?.endsAt ? Math.max(0, ivState.endsAt - serverNow) : null;
    const cooldownLeft = Math.max(0, cooldownUntil - now);
    const maxSubmissions = ivState?.maxSubmissions ?? 0;
    const submissionsUsed = ivState?.submissionsUsed ?? 0;
    const canSubmit = isCandidate
        && status === 'running'
        && cooldownLeft === 0
        && submissionsUsed < maxSubmissions;
    // The candidate may only type while the interview runs; the interviewer
    // watches the code and never edits it.
    const readOnly = isCandidate ? status !== 'running' : true;

    const statusLabel = { lobby: 'Lobby', running: 'In progress', ended: 'Ended' }[status] || status;

    useEffect(() => {
        if (editorRef.current) editorRef.current.updateOptions({ readOnly });
    }, [readOnly]);

    const destroySession = useCallback(() => {
        if (bindingRef.current) {
            bindingRef.current.destroy();
            bindingRef.current = null;
        }
        if (sessionRef.current) {
            sessionRef.current.destroy();
            sessionRef.current = null;
        }
    }, []);

    const startSession = useCallback((name) => {
        destroySession();
        // The Yjs session has to exist BEFORE the join is emitted: the server
        // replies with "yjs-init" during the join, and a late listener would
        // miss it (the local doc would then stay empty and out of sync).
        sessionRef.current = createSession(socket, name);
    }, [destroySession]);

    const createInterview = () => {
        const name = userName.trim();
        if (!name) {
            setError('Please enter your name.');
            return;
        }
        setBusy(true);
        setError('');
        startSession(name);
        socket.emit('create-interview', { userName: name }, (ack) => {
            setBusy(false);
            if (!ack || !ack.ok) {
                setError(ack?.error || 'Failed to create the interview.');
                destroySession();
                return;
            }
            writeStoredKey('interviewer', ack.roomId, ack.interviewerKey);
            joinRef.current = {
                roomId: ack.roomId,
                userName: name,
                interviewerKey: ack.interviewerKey,
            };
            setRoomId(ack.roomId);
            setRole('interviewer');
            setStage('room');
        });
    };

    const joinInterview = () => {
        const name = userName.trim();
        const room = roomId.trim();
        if (!name) {
            setError('Please enter your name.');
            return;
        }
        if (!room) {
            setError('Please enter the room id.');
            return;
        }
        setBusy(true);
        setError('');
        startSession(name);
        // A stored interviewer key makes this browser the interviewer; a stored
        // candidate key reclaims the candidate slot after a refresh.
        const interviewerKey = readStoredKey('interviewer', room);
        const candidateKey = readStoredKey('candidate', room);
        socket.emit('join-interview', {
            roomId: room,
            userName: name,
            ...(interviewerKey ? { interviewerKey } : {}),
            ...(candidateKey ? { candidateKey } : {}),
        }, (ack) => {
            setBusy(false);
            if (!ack || !ack.ok) {
                setError(ack?.error || 'Failed to join the interview.');
                destroySession();
                return;
            }
            const nextRole = ack.role || 'candidate';
            if (nextRole === 'candidate' && ack.candidateKey) {
                writeStoredKey('candidate', room, ack.candidateKey);
            }
            joinRef.current = {
                roomId: room,
                userName: name,
                interviewerKey: nextRole === 'interviewer' ? interviewerKey : null,
                candidateKey: nextRole === 'candidate' ? (ack.candidateKey || candidateKey) : null,
            };
            setRole(nextRole);
            setStage('room');
        });
    };

    const configure = (problemId, durationMin) => {
        socket.emit('interview-configure', { problemId, durationMin });
    };

    const startInterview = () => socket.emit('interview-start');
    const endInterview = () => socket.emit('interview-end');

    const submitSolution = () => {
        if (!canSubmit) return;
        setRejection('');
        socket.emit('interview-submit');
        setCooldownUntil(Date.now() + SUBMIT_COOLDOWN_MS);
    };

    const changeLanguage = (e) => {
        const newLanguage = e.target.value;
        setLanguage(newLanguage);
        const session = sessionRef.current;
        if (session) {
            const currentText = session.ytext.toString();
            if (isDefaultTemplate(currentText)) {
                const template = TEMPLATES[newLanguage] || '// Start your code here';
                session.doc.transact(() => {
                    session.ytext.delete(0, session.ytext.length);
                    session.ytext.insert(0, template);
                });
            }
        }
        socket.emit('languageChange', { language: newLanguage });
    };

    const runCode = () => {
        if (!isCandidate || status !== 'running') return;
        socket.emit('compileCode', { language, input: userInput });
    };

    const copyRoomId = () => {
        navigator.clipboard.writeText(roomId);
        setCopySuccess('Copied!');
        setTimeout(() => setCopySuccess(''), 2000);
    };

    const copyInviteLink = () => {
        const url = `${window.location.origin}/?interview=1&room=${encodeURIComponent(roomId)}`;
        navigator.clipboard.writeText(url);
        setCopySuccess('Link copied!');
        setTimeout(() => setCopySuccess(''), 2000);
    };

    const fetchReport = async () => {
        const info = joinRef.current;
        if (!info?.interviewerKey) {
            setReportError('Only the interviewer can load the report.');
            return;
        }
        setReportError('');
        try {
            const res = await fetch(`${API_BASE}/api/interview/${roomId}/report`, {
                headers: { 'x-interviewer-key': info.interviewerKey },
            });
            if (res.status === 409) {
                setReportError('The interview has not finished yet.');
                return;
            }
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                setReportError(body?.error || `Request failed (${res.status}).`);
                return;
            }
            setReport(await res.json());
        } catch (err) {
            setReportError(err?.message || 'Failed to load the report.');
        }
    };

    const leaveInterview = () => {
        socket.emit('leave-room');
        destroySession();
        window.location.href = '/';
    };

    if (stage === 'setup') {
        return (
            <div className="join-container interview-setup">
                <div className="join-form">
                    <h2>Interview Mode</h2>
                    <p className="iv-hint">Solve a problem together with live judging, hidden tests and a full session report.</p>
                    <div className="iv-mode-tabs">
                        <button
                            type="button"
                            className={mode === 'interviewer' ? 'active' : ''}
                            onClick={() => { setMode('interviewer'); setError(''); }}
                        >
                            Interviewer
                        </button>
                        <button
                            type="button"
                            className={mode === 'candidate' ? 'active' : ''}
                            onClick={() => { setMode('candidate'); setError(''); }}
                        >
                            Candidate
                        </button>
                    </div>
                    <input
                        type="text"
                        placeholder="Your name"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                    />
                    {mode === 'candidate' && (
                        <input
                            type="text"
                            placeholder="Room ID"
                            value={roomId}
                            onChange={(e) => setRoomId(e.target.value)}
                        />
                    )}
                    {error && <div className="iv-error">{error}</div>}
                    <button onClick={mode === 'interviewer' ? createInterview : joinInterview} disabled={busy}>
                        {busy ? 'Please wait...' : mode === 'interviewer' ? 'Create interview' : 'Join interview'}
                    </button>
                    <button type="button" className="iv-secondary" onClick={() => { window.location.href = '/'; }}>
                        Back to collaboration
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="editor-container interview-container">
            <div className="sidebar interview-sidebar">
                <div className="room-info">
                    <h2>Interview {roomId}</h2>
                    <div className="iv-badges">
                        <span className={`iv-badge status-${status}`}>{statusLabel}</span>
                        {ivState?.problem && <span className="iv-badge">{ivState.problem.difficulty}</span>}
                        <span className="iv-badge">{isInterviewer ? 'Interviewer' : isCandidate ? 'Candidate' : 'Viewer'}</span>
                        {ended?.endReason && <span className="iv-badge">{ended.endReason}</span>}
                    </div>
                    {remainingMs !== null && (
                        <div className={`iv-timer${remainingMs < 60000 ? ' urgent' : ''}`}>{formatClock(remainingMs)}</div>
                    )}
                    <button onClick={copyRoomId} className="copy-button">Copy Id</button>
                    {isInterviewer && (
                        <button onClick={copyInviteLink} className="copy-button">Copy invite link</button>
                    )}
                    {copySuccess && <span className="copy-success">{copySuccess}</span>}
                </div>

                {isInterviewer && status === 'lobby' && (
                    <div className="iv-panel">
                        <h3>Setup</h3>
                        <label className="iv-field">
                            Problem
                            <select
                                value={selectedProblem}
                                onChange={(e) => {
                                    setSelectedProblem(e.target.value);
                                    if (e.target.value) configure(e.target.value, selectedDuration);
                                }}
                            >
                                <option value="">Select a problem...</option>
                                {(ivState?.problemBank || []).map((p) => (
                                    <option key={p.id} value={p.id}>{p.title} ({p.difficulty})</option>
                                ))}
                            </select>
                        </label>
                        <label className="iv-field">
                            Duration
                            <select
                                value={selectedDuration}
                                onChange={(e) => {
                                    const mins = Number(e.target.value);
                                    setSelectedDuration(mins);
                                    if (selectedProblem) configure(selectedProblem, mins);
                                }}
                            >
                                {DURATIONS_MIN.map((m) => (
                                    <option key={m} value={m}>{m} minutes</option>
                                ))}
                            </select>
                        </label>
                        <button className="iv-start" onClick={startInterview} disabled={!ivState?.problem}>
                            Start interview
                        </button>
                    </div>
                )}

                {isInterviewer && status === 'running' && (
                    <div className="iv-panel">
                        <button className="iv-end" onClick={endInterview}>End interview</button>
                    </div>
                )}


                {ivState?.problem ? (
                    <div className="iv-panel iv-problem">
                        <h3>{ivState.problem.title}</h3>
                        <pre className="iv-statement">{ivState.problem.statement}</pre>
                        {ivState.problem.samples?.length > 0 && (
                            <div className="iv-samples">
                                <h4>Samples</h4>
                                {ivState.problem.samples.map((s, i) => (
                                    <div key={i} className="iv-sample">
                                        <pre>{s.input}</pre>
                                        <pre>{s.output}</pre>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="iv-panel">
                        <p className="iv-muted">
                            {isInterviewer
                                ? 'Pick a problem to start the interview.'
                                : 'Waiting for the interviewer to share a problem...'}
                        </p>
                    </div>
                )}

                {isCandidate && (
                    <div className="iv-panel">
                        <h3>Your submissions ({results.length}/{maxSubmissions})</h3>
                        {results.length === 0 && <p className="iv-muted">No submissions yet.</p>}
                        {results.map((r) => (
                            <div key={r.index} className="iv-result">
                                <div className="iv-result-head">
                                    <span className={`iv-verdict v-${r.verdict}`}>{r.verdict}</span>
                                    <span className="iv-muted">{VERDICT_TEXT[r.verdict] || r.verdict}</span>
                                    <span>{r.passed}/{r.total} passed</span>
                                </div>
                                <div className="iv-chips">
                                    {r.tests.map((t) => (
                                        <span key={t.i} className={`iv-verdict small v-${t.verdict}`} title={`Test ${t.i + 1}`}>
                                            {t.verdict}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        ))}
                        {rejection && <div className="iv-error">{rejection}</div>}
                        <button className="iv-submit" onClick={submitSolution} disabled={!canSubmit}>
                            {cooldownLeft > 0
                                ? `Wait ${Math.ceil(cooldownLeft / 1000)}s`
                                : status !== 'running' ? 'Submit (interview not running)' : 'Submit solution'}
                        </button>
                    </div>
                )}

                {isInterviewer && (
                    <div className="iv-panel">
                        <h3>Submissions ({submissions.length}/{maxSubmissions})</h3>
                        {submissions.length === 0 && <p className="iv-muted">No submissions yet.</p>}
                        {submissions.map((s) => (
                            <div key={s.index} className="iv-result">
                                <div className="iv-result-head">
                                    <span className={`iv-verdict v-${s.verdict}`}>{s.verdict}</span>
                                    <span className="iv-muted">#{s.index + 1} · {s.language} · {formatElapsed(s.t)}</span>
                                    <span>{s.passed}/{s.total} passed</span>
                                </div>
                                <div className="iv-chips">
                                    {s.tests.map((t) => (
                                        <details key={t.i} className="iv-test">
                                            <summary>
                                                <span className={`iv-verdict small v-${t.verdict}`}>{t.verdict}</span>
                                                <span className="iv-muted">test {t.i + 1}</span>
                                            </summary>
                                            <div className="iv-test-body">
                                                <div><span className="iv-muted">input</span><pre>{t.input}</pre></div>
                                                <div><span className="iv-muted">expected</span><pre>{t.expected}</pre></div>
                                                <div><span className="iv-muted">actual</span><pre>{t.actual || '(empty)'}</pre></div>
                                            </div>
                                        </details>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}


                {isInterviewer && status === 'ended' && (
                    <div className="iv-panel">
                        <h3>Report</h3>
                        <button className="iv-load-report" onClick={fetchReport}>Load report</button>
                        {reportError && <div className="iv-error">{reportError}</div>}
                        {report && (
                            <div className="iv-report">
                                <div><span className="iv-muted">Problem</span> {report.problem?.title || '-'}</div>
                                <div><span className="iv-muted">Candidate</span> {report.candidateName || '-'}</div>
                                <div><span className="iv-muted">Used</span> {formatElapsed(report.usedMs)}</div>
                                {report.final && (
                                    <div>
                                        <span className="iv-muted">Final</span>
                                        <span className={`iv-verdict v-${report.final.verdict}`}>{report.final.verdict}</span>
                                        <span>{report.final.passed}/{report.final.total}</span>
                                    </div>
                                )}
                                <a href={report.replayPath} target="_blank" rel="noreferrer">Watch replay</a>
                            </div>
                        )}
                    </div>
                )}

                <h3>Users in Room:</h3>
                <ul>
                    {users.map((user, index) => (
                        <li key={`${user}-${index}`}>{user}</li>
                    ))}
                </ul>

                <label className="iv-field">
                    Language
                    <select
                        className="language-selector"
                        value={language}
                        onChange={changeLanguage}
                        disabled={!isCandidate}
                    >
                        {LANGUAGES.map((l) => (
                            <option key={l.value} value={l.value}>{l.label}</option>
                        ))}
                    </select>
                </label>
                {!isCandidate && <p className="iv-muted">The candidate picks the language.</p>}

                <button className="leave-button" onClick={leaveInterview}>Leave interview</button>
            </div>

            <div className="editor-wrapper">
                <Editor
                    height="100%"
                    language={language}
                    theme="vs-dark"
                    options={{
                        minimap: { enabled: false },
                        fontSize: 16,
                        readOnly,
                    }}
                    onMount={(editor) => {
                        editorRef.current = editor;
                        const session = sessionRef.current;
                        if (!session || bindingRef.current) return;
                        const model = editor.getModel();
                        if (!model) return;
                        const binding = new MonacoBinding(
                            session.ytext,
                            model,
                            new Set([editor]),
                            session.awareness
                        );
                        bindingRef.current = binding;
                    }}
                />
                {isCandidate && (
                    <>
                        <textarea
                            className="input-console"
                            placeholder="Optional stdin for the sample run..."
                            value={userInput}
                            onChange={(e) => setUserInput(e.target.value)}
                        />
                        <button
                            className="run-btn"
                            onClick={runCode}
                            disabled={running || status !== 'running'}
                        >
                            {running ? 'Running...' : 'Run sample'}
                        </button>
                        <textarea
                            className="output-area"
                            value={output}
                            readOnly
                            placeholder="Output will appear here..."
                        />
                    </>
                )}
            </div>
        </div>
    );
};

export default Interview;

