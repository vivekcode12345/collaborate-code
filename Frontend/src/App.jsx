import './App.css'
import io from 'socket.io-client'
import { useState, useEffect, useRef, useCallback } from 'react';
import { Editor } from '@monaco-editor/react'
import { createSession } from './yjsProvider'
import { MonacoBinding } from 'y-monaco';

import './monacoSetup'

const socket = io(import.meta.env.VITE_SOCKET_URL || '/');

const TEMPLATES = {
    javascript: `// Hello World
console.log("Hello, World!");`,
    python: `# Hello World
print("Hello, World!")`,
    java: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }
}`,
    cpp: `#include <iostream>

int main() {
    std::cout << "Hello, World!" << std::endl;
    return 0;
}`,
};

const isDefaultTemplate = (code) => {
    return Object.values(TEMPLATES).includes(code) || code.startsWith("// Start");
};

function escapeCssString(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\A ');
}

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [copySuccess, setCopySuccess] = useState("");
  const [users, setUsers] = useState([]);
  const [output, setOutput] = useState("");
  const [userInput, setUserInput] = useState("");
  const [running, setRunning] = useState(false);

  const joinInfo = useRef(null);
  const sessionRef = useRef(null);
  const bindingRef = useRef(null);

  const updateRemoteCursorStyles = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const styles = [];
    session.awareness.getStates().forEach((state, clientID) => {
      if (clientID === session.doc.clientID) return;
      const user = state?.user;
      const color = user?.color || '#e74c3c';
      const name = escapeCssString(user?.name || 'User');
      styles.push(`
.yRemoteSelection-${clientID} { background-color: ${color}5a !important; }
.yRemoteSelectionHead-${clientID} {
  position: absolute;
  border-left: 2px solid ${color};
  height: 100%;
  box-sizing: border-box;
  z-index: 100;
}
.yRemoteSelectionHead-${clientID}::before {
  content: "${name}";
  position: absolute;
  top: -1.4em;
  left: -2px;
  font-size: 11px;
  padding: 1px 4px;
  color: #fff;
  background: ${color};
  border-radius: 3px;
  white-space: nowrap;
  z-index: 100;
  pointer-events: none;
}
      `);
    });
    let el = document.getElementById('remote-cursor-styles');
    if (!el) {
      el = document.createElement('style');
      el.id = 'remote-cursor-styles';
      document.head.appendChild(el);
    }
    el.textContent = styles.join('\n');
  }, []);

  function removeRemoteCursorStyles() {
    const el = document.getElementById('remote-cursor-styles');
    if (el) el.remove();
  }

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
      sessionRef.current.awareness.on('change', updateRemoteCursorStyles);
      socket.emit("join", info);
      setJoined(true);
    }
  }

  const copyRoomId=()=>{
    navigator.clipboard.writeText(roomId);
    setCopySuccess("Copied!");
    setTimeout(() => setCopySuccess(""), 2000); // Clear the message after 2 seconds
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
      sessionRef.current.awareness.off('change', updateRemoteCursorStyles);
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
            updateRemoteCursorStyles();
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

export default App;