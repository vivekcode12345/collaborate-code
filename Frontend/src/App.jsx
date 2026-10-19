import './App.css'
import io from 'socket.io-client'
import { useState, useEffect, useRef } from 'react';
import { Editor } from '@monaco-editor/react'

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

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [code, setCode] = useState("// Start your code here");
  const [copySuccess, setCopySuccess] = useState("");
  const [typing, setTyping] = useState("");
  const [users, setUsers] = useState([]);
  const [output, setOutput] = useState("");
  const [userInput, setUserInput] = useState("");
  const [running, setRunning] = useState(false);

  const lastTypingEmit = useRef(0);
  const typingTimeout = useRef(null);
  const joinInfo = useRef(null);

  useEffect(() => {
    socket.on("user-joined", (users) => {
      setUsers(users);
    });

    socket.on("codeUpdate", (newCode) => {
      setCode(newCode);
    });

    socket.on("userTyping", (name) => {
      setTyping(`${name} is typing...`);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => setTyping(""), 2000);
    });

    socket.on("user-Left", (users) => {
      setUsers(users);
    });

    socket.on("languageChange", (newLanguage) => {
      setLanguage(newLanguage);
    }
    );
   
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
      socket.off("codeUpdate");
      socket.off("userTyping");
      socket.off("languageChange");
      socket.off("codeRunning");
      socket.off("codeResponse");
      socket.off("connect");
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    };
  }, []);



  const joinRoom=()=>{
    if(roomId && userName){
      const info = { roomId, userName };
      joinInfo.current = info;
      socket.emit("join", info);
      setJoined(true);
    }
  }

  const copyRoomId=()=>{
    navigator.clipboard.writeText(roomId);
    setCopySuccess("Copied!");
    setTimeout(() => setCopySuccess(""), 2000); // Clear the message after 2 seconds
  };

  const handleCodeChange=(newCode)=>{
    setCode(newCode);
    socket.emit("codeChange", { code: newCode });
    const now = Date.now();
    if (now - lastTypingEmit.current > 1000) {
      socket.emit("userTyping");
      lastTypingEmit.current = now;
    }
  };

  const handleLanguageChange=(e)=>{
    const newLanguage = e.target.value;
    setLanguage(newLanguage);
    if (isDefaultTemplate(code)) {
      const template = TEMPLATES[newLanguage] || "// Start your code here";
      setCode(template);
      socket.emit("codeChange", { code: template });
    }
    socket.emit("languageChange", { language: newLanguage });
  };

  const handleUserInput=(e)=>{
    setUserInput(e.target.value);
  };

  const runCode=()=>{
    socket.emit("compileCode", { code, language, input: userInput });
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
    setCode("// Start your code here");
    setLanguage("javascript");
    setOutput("");
    setUserInput("");
    setTyping("");
    joinInfo.current = null;
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
        {typing && <p className="typing-indicator">{typing}</p>}
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
          value={code}
          onChange={handleCodeChange}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 16,
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