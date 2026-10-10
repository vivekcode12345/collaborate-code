import './App.css'
import io from 'socket.io-client'
import { useState } from 'react';

const socket = io('http://localhost:5000');

const App = () => {
  const [joined, setJoined] = useState(false);
  if(!joined){
    return  <div> <h1>Join the chat</h1> </div> 
  }
  return <div>User Joined</div>
}

export default App;