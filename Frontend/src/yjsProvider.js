import { Doc as YDoc } from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import { applyUpdate, encodeStateAsUpdate } from 'yjs';

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db',
  '#9b59b6', '#1abc9c', '#e91e63', '#ff9800', '#673ab7',
];

function colorForName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function createSession(socket, userName) {
  const doc = new YDoc();
  const awareness = new Awareness(doc);
  const ytext = doc.getText('monaco');

  awareness.setLocalState({
    user: { name: userName, color: colorForName(userName) },
  });

  const listeners = [];

  function onSocketYjsUpdate(data) {
    applyUpdate(doc, new Uint8Array(data), 'remote');
  }

  function onSocketAwarenessUpdate(data) {
    applyAwarenessUpdate(awareness, new Uint8Array(data), 'remote');
  }

  function onSocketYjsInit({ doc: d, awareness: a }) {
    applyUpdate(doc, new Uint8Array(d), 'remote');
    if (a && a.byteLength) {
      applyAwarenessUpdate(awareness, new Uint8Array(a), 'remote');
    }
    socket.emit('yjs-update', encodeStateAsUpdate(doc));
    socket.emit(
      'awareness-update',
      encodeAwarenessUpdate(awareness, [doc.clientID])
    );
  }

  doc.on('update', (update, origin) => {
    if (origin !== 'remote') {
      socket.emit('yjs-update', update);
    }
  });

  awareness.on(
    'update',
    ({ added, updated, removed }, origin) => {
      if (origin !== 'remote') {
        socket.emit(
          'awareness-update',
          encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])
        );
      }
    }
  );

  socket.on('yjs-update', onSocketYjsUpdate);
  socket.on('awareness-update', onSocketAwarenessUpdate);
  socket.on('yjs-init', onSocketYjsInit);

  listeners.push(
    () => socket.off('yjs-update', onSocketYjsUpdate),
    () => socket.off('awareness-update', onSocketAwarenessUpdate),
    () => socket.off('yjs-init', onSocketYjsInit)
  );

  return {
    doc,
    awareness,
    ytext,
    destroy() {
      listeners.forEach((fn) => fn());
      awareness.setLocalState(null);
      awareness.destroy();
      doc.destroy();
    },
  };
}