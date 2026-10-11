import './App.css'
import io from 'socket.io-client'
import { useState } from 'react';
import { Editor } from '@monaco-editor/react'
const socket = io(window.location.origin);
import { useEffect } from 'react';

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [language, setLanguage]= useState('javascript');
  const [code, setCode] = useState('');
  const [copySuccess, setCopySuccess] = useState("");
  const [typing, setTyping] = useState(false);
  const [users, setUsers] = useState([]);
  useEffect(() => {
    socket.on("user-joined", (users) => {
      setUsers(users);
    });

    socket.on("codeUpdate", (newCode) => {
      setCode(newCode);
    });

    socket.on("userTyping", (userName) => {
      setTyping(`${userName} is typing...`);
      setTimeout(() => setTyping(false), 2000); // Clear the typing indicator after 2 seconds
    }
    );

    socket.on("user-Left", (users) => {
      setUsers(users);
    });

    socket.on("languageChange", (newLanguage) => {
      setLanguage(newLanguage);
    }
    );


    return () => {
      socket.off("user-joined");
      socket.off("user-Left");
      socket.off("codeUpdate");
      socket.off("userTyping");
      socket.off("languageChange");

    };
  }, []);

   useEffect(() => {
    const handleBeforeUnload = () => {
      socket.emit("leave-room");
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  const joinRoom=()=>{
    if(roomId && userName){
      socket.emit("join", {roomId, userName});
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
    socket.emit("codeChange", {roomId, code: newCode});
    socket.emit("userTyping", {roomId, userName});
  };

  const handleLanguageChange=(e)=>{
    const newLanguage = e.target.value;
    setLanguage(newLanguage);
    socket.emit("languageChange", {roomId, language: newLanguage});
  };

  const leaveRoom=()=>{
    socket.emit("leave-room");
    setJoined(false);
    setRoomId("");
    setUserName("");
  };


  if(!joined){
    return <div className="join-container">
      <div className="join-form">
        <h2>Join Room</h2>

        <input type="text" 
        placeholder="Room ID" 
        value={roomId} 
        onChange={(e) => setRoomId(e.target.value)} />

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
            <li key={index}>{user}</li>
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
          height={"100%"}
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
      </div>
    </div>
  );
}

export default App;