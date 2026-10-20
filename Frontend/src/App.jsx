import './App.css'
import { useState, useEffect, useRef, useCallback } from 'react';
import { Editor } from '@monaco-editor/react'
import { createSession } from './yjsProvider'
import { MonacoBinding } from 'y-monaco';
import Replay from './Replay'
import Interview from './Interview'
import socket from './socket'
import { TEMPLATES, isDefaultTemplate } from './templates'
import { updateRemoteCursorStyles, removeRemoteCursorStyles } from './remoteCursors'

import './monacoSetup'

const LiveApp = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [copySuccess, setCopySuccess] = useState("");
  const [users, setUsers] = useState([]);
  const [output, setOutput] = useState("");
  const [userInput, setUserInput] = useState("");
  const [running, setRunning] = useState(false);
  const [replayInput, setReplayInput] = useState('');
  const [interviewName, setInterviewName] = useState('');
  const [interviewError, setInterviewError] = useState('');

  const joinInfo = useRef(null);
  const sessionRef = useRef(null);
  const bindingRef = useRef(null);

  const refreshRemoteCursorStyles = useCallback(() => {
    updateRemoteCursorStyles(sessionRef.current);
  }, []);

  useEffect(() => {
    socket.on("user-joined", (usersList) => {
      setUsers(usersList);
    });

    socket.on("user-Left", (usersList) => {
      setUsers(usersList);
    });

    socket.on("languageChange", (newLanguage) => {
      setLanguage(newLanguage);
    });
   
    socket.on("codeRunning", () => {
      setRunning(true);
      setOutput("Running...");
    });

    socket.on("codeResponse", (response) => {
      setRunning(false);
      setOutput(response.run?.output ?? "");
    });

    socket.on("connect", () => {
      if (joinInfo.current) {
        socket.emit("join", joinInfo.current);
      }
    });

    return () => {
      socket.off("user-joined");
      socket.off("user-Left");
      socket.off("yjs-init");
      socket.off("languageChange");
      socket.off("codeRunning");
      socket.off("codeResponse");
      socket.off("connect");
      removeRemoteCursorStyles();
    };
  }, []);



  const joinRoom=()=>{
    if(roomId && userName){
      const info = { roomId, userName };
      joinInfo.current = info;
      sessionRef.current = createSession(socket, userName);
      sessionRef.current.awareness.on('change', refreshRemoteCursorStyles);
      socket.emit("join", info);
      setJoined(true);
    }
  }

  const copyRoomId=()=>{
    navigator.clipboard.writeText(roomId);
    setCopySuccess("Copied!");
    setTimeout(() => setCopySuccess(""), 2000); // Clear the message after 2 seconds
  };

  const copyReplayLink=()=>{
    navigator.clipboard.writeText(`${window.location.origin}/?replay=${roomId}`);
    setCopySuccess("Copied!");
    setTimeout(() => setCopySuccess(""), 2000);
  };

  const handleLanguageChange=(e)=> {
    const newLanguage = e.target.value;
    setLanguage(newLanguage);
    const session = sessionRef.current;
    if (session) {
      const currentText = session.ytext.toString();
      if (isDefaultTemplate(currentText)) {
        const template = TEMPLATES[newLanguage] || "// Start your code here";
        session.doc.transact(() => {
          session.ytext.delete(0, session.ytext.length);
          session.ytext.insert(0, template);
        });
      }
    }
    socket.emit("languageChange", { language: newLanguage });
  };

  const handleUserInput=(e)=>{
    setUserInput(e.target.value);
  };

  const runCode=()=>{
    socket.emit("compileCode", { language, input: userInput });
  }

  const createRoomId=()=>{
    const id = Math.random().toString(36).substring(2, 10);
    setRoomId(id);
  }

  const createInterview = () => {
    const name = interviewName.trim();
    if (!name) {
      setInterviewError('Enter your name to create an interview.');
      return;
    }
    setInterviewError('');
    socket.emit('create-interview', { userName: name }, (ack) => {
      if (!ack?.ok) {
        setInterviewError(ack?.error || 'Could not create interview.');
        return;
      }
      localStorage.setItem(`interview-key:${ack.roomId}`, ack.interviewerKey);
      localStorage.setItem(`interview-name:${ack.roomId}`, name);
      window.location.href = `/?interview=${encodeURIComponent(ack.roomId)}`;
    });
  };

  const leaveRoom=()=>{
    socket.emit("leave-room");
    setJoined(false);
    setRoomId("");
    setUserName("");
    setLanguage("javascript");
    setOutput("");
    setUserInput("");
    joinInfo.current = null;
    if (bindingRef.current) {
      bindingRef.current.destroy();
      bindingRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.awareness.off('change', refreshRemoteCursorStyles);
      sessionRef.current.destroy();
      sessionRef.current = null;
    }
    removeRemoteCursorStyles();
  };


  if(!joined){
    return <div className="join-container">
      <div className="join-form">
        <h2>Join Room</h2>

        <input type="text" 
        placeholder="Room ID" 
        value={roomId} 
        onChange={(e) => setRoomId(e.target.value)} />
        <button onClick={createRoomId}>Create Room</button>

        <input type="text" 
        placeholder="User Name" 
        value={userName} 
        onChange={(e) => setUserName(e.target.value)} />
        <button onClick={joinRoom}>Join</button>

        <div className="replay-section">
          <h3>Interview mode</h3>
          <input
            type="text"
            placeholder="Your name"
            value={interviewName}
            onChange={(e) => setInterviewName(e.target.value)}
          />
          <button onClick={createInterview}>Create Interview</button>
          {interviewError && <div className="iv-error">{interviewError}</div>}
        </div>

        <div className="replay-section">
          <h3>Watch a replay</h3>
          <input type="text"
            placeholder="Room ID"
            value={replayInput}
            onChange={(e) => setReplayInput(e.target.value)} />
          <button onClick={() => { if (replayInput) window.location.href = `/?replay=${encodeURIComponent(replayInput)}`; }}>
            Watch Replay
          </button>
        </div>
      </div>
    </div>
  }

  return (
    <div className="editor-container">
      <div className="sidebar">
        <div className="room-info">
          <h2>Code Room: {roomId}</h2>
          <button onClick={copyRoomId} className="copy-button">
            Copy Id
          </button>
          <button onClick={copyReplayLink} className="copy-button">
            Copy replay link
          </button>
          {copySuccess && <span className="copy-success">{copySuccess}</span>}
        </div>
        <h3>Users in Room:</h3>
        <ul>
          {users.map((user, index) => (
            <li key={`${user}-${index}`}>{user}</li>
          ))}
        </ul>
        <select className="language-selector" 
        value={language} 
        onChange={handleLanguageChange}>

          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="java">Java</option>
          <option value="cpp">C++</option>
        </select>
        <button className="leave-button" onClick={leaveRoom}>
          Leave Room
        </button>
      </div>
      <div className="editor-wrapper">
        <Editor 
          height="100%"
          defaultLanguage={language} 
          language={language}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 16,
          }}
          onMount={(editor) => {
            const session = sessionRef.current;
            if (!session || bindingRef.current) return;
            const model = editor.getModel();
            const binding = new MonacoBinding(
              session.ytext,
              model,
              new Set([editor]),
              session.awareness
            );
            bindingRef.current = binding;
            // Refresh remote cursor styles now that decorations can render.
            refreshRemoteCursorStyles();
            return () => {
              if (bindingRef.current) {
                bindingRef.current.destroy();
                bindingRef.current = null;
              }
            };
          }}
        />
        <textarea className="input-console" placeholder="Enter input for the program..." value={userInput} onChange={handleUserInput}/>
        <button className="run-btn" onClick={runCode} disabled={running}>
          {running ? "Running..." : "Execute Code"}
        </button>
        <textarea className="output-area" value={output} readOnly placeholder="Output will appear here..."/>
      </div>
    </div>
  );
}

// Replay mode: ?replay=<roomId> renders the Replay screen instead of the join flow.
// Interview mode: ?interview=1 renders the interview screen (a real page load, so
// the collaboration socket/session is never shared with the interview one).
const appParams = new URLSearchParams(window.location.search);
const replayRoomId = appParams.get('replay');
const interviewMode = appParams.get('interview');

const App = () => {
  if (replayRoomId) return <Replay roomId={replayRoomId} />;
  if (interviewMode) return <Interview roomId={interviewMode} />;
  return <LiveApp />;
};

export default App;