import './App.css'
import io from 'socket.io-client'
import { useState } from 'react';

const socket = io('http://localhost:5000');

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');

  const joinRoom=()=>{
    if(roomId && userName){
      socket.emit("join", {roomId, userName});
      setJoined(true);
    }
  }

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
  return <div>User Joined</div>
}

export default App;