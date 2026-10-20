import { useEffect, useRef, useState } from 'react';
import { Button, Card, Input, Logo, ThemeToggle } from './components/ui';
import { CodeIcon, CursorIcon, ReplayIcon } from './components/Icons';
import { useTheme } from './hooks/useTheme';
import socket from './socket';
import './styles/home.css';

export default function Home() {
  const params = new URLSearchParams(window.location.search);
  const [roomId, setRoomId] = useState(params.get('room') || '');
  const [name, setName] = useState('');
  const [interviewName, setInterviewName] = useState('');
  const [replayRoom, setReplayRoom] = useState('');
  const [error, setError] = useState('');
  const [interviewError, setInterviewError] = useState('');
  const nameRef = useRef(null);
  const { theme, toggle } = useTheme();

  const presetRoom = params.get('room');
  useEffect(() => {
    if (presetRoom) nameRef.current?.focus();
  }, [presetRoom]);
  const createRoomId = () => setRoomId(Math.random().toString(36).substring(2, 10));
  const join = () => {
    if (!roomId.trim() || !name.trim()) {
      setError(!roomId.trim() ? 'Enter a room ID.' : 'Enter your name.');
      return;
    }
    window.location.href = `/?room=${encodeURIComponent(roomId.trim())}&name=${encodeURIComponent(name.trim())}`;
  };
  const createInterview = () => {
    const userName = interviewName.trim();
    if (!userName) { setInterviewError('Enter your name to create an interview.'); return; }
    setInterviewError('');
    socket.emit('create-interview', { userName }, (ack) => {
      if (!ack?.ok) { setInterviewError(ack?.error || 'Could not create interview.'); return; }
      localStorage.setItem(`interview-key:${ack.roomId}`, ack.interviewerKey);
      localStorage.setItem(`interview-name:${ack.roomId}`, userName);
      window.location.href = `/?interview=${encodeURIComponent(ack.roomId)}`;
    });
  };
  const watch = () => replayRoom.trim() && (window.location.href = `/?replay=${encodeURIComponent(replayRoom.trim())}`);
  return <main className="cc-home">
    <div className="cc-home-inner">
      <header className="cc-home-topbar"><Logo /><ThemeToggle theme={theme} toggle={toggle} /></header>
      <section className="cc-hero"><h1>Code together.<br /><span style={{ color: 'var(--accent)' }}>Interview better.</span></h1><p>Real-time collaborative editor with live cursors, sandboxed execution, session replay and interview mode.</p></section>
      <section className="cc-home-grid">
        <Card className="cc-home-card"><h2>Join or create a room</h2><p>Collaborate in a shared live coding room.</p><Input label="Your name" value={name} onChange={(e) => { setName(e.target.value); setError(''); }} ref={nameRef} placeholder="Ada Lovelace" /><div style={{ display: 'flex', gap: 8 }}><Input label="Room ID" value={roomId} onChange={(e) => { setRoomId(e.target.value); setError(''); }} placeholder="room-id" /><Button type="button" size="small" onClick={createRoomId}>Generate</Button></div>{error && <span className="cc-field-error">{error}</span>}<Button variant="primary" onClick={join}>Join room</Button></Card>
        <Card className="cc-home-card"><h2>Start an interview</h2><p>Set up a structured coding interview with a private candidate link.</p><Input label="Your name" value={interviewName} onChange={(e) => { setInterviewName(e.target.value); setInterviewError(''); }} placeholder="Interviewer name" />{interviewError && <span className="cc-field-error">{interviewError}</span>}<Button variant="primary" onClick={createInterview}>Create interview</Button></Card>
        <Card className="cc-home-card"><h2>Watch a replay</h2><p>Review a completed coding session from its room ID.</p><Input label="Room ID" value={replayRoom} onChange={(e) => setReplayRoom(e.target.value)} placeholder="room-id" /><Button onClick={watch}>Watch replay</Button></Card>
      </section>
      <section className="cc-feature-strip">
        <div className="cc-feature"><CodeIcon />CRDT live sync</div><div className="cc-feature"><CursorIcon />Live cursors</div><div className="cc-feature"><span>⚡</span>Sandboxed execution (JS, Python, C++, Java)</div><div className="cc-feature"><ReplayIcon />Session replay &amp; interview mode</div>
      </section>
      <footer className="cc-footer">Built for thoughtful collaboration · <a href="#">GitHub</a></footer>
    </div>
  </main>;
}
