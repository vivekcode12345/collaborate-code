import './App.css'
import io from 'socket.io-client'
import { useState } from 'react';
import Editor from 'monaco-editor';
const socket = io('http://localhost:5000');

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [language, setLanguage]= useState('javascript');
  const [code, setCode] = useState('');

  const joinRoom=()=>{
    if(roomId && userName){
      socket.emit("join", {roomId, userName});
      setJoined(true);
    }
  }

  const copyRoomId=()=>{
    
  };

  const handleCodeChange=(newCode)=>{
    setCode(newCode);
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
        </div>
        <h3>Users in Room:</h3>
        <ul>
          <li>Vivek verma</li>
          <li>xyz</li>
        </ul>
        <p className="typing-indicator">User typing...</p>
        <select className="language-selector">
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="java">Java</option>
          <option value="cpp">C++</option>
        </select>
        /* Leave room button */
        <button className="leave-button" onClick={leaveRoom}>
          Leave Room
        </button>
      </div>
      <div className="editor-wrapper">
        <Editor 
          height={"100"} 
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