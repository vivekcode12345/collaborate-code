export function escapeCssString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\A ');
}

export function updateRemoteCursorStyles(session) {
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
  font-family: Inter, system-ui, sans-serif;
  background: ${color};
  border-radius: 4px;
  box-shadow: 0 2px 6px rgb(0 0 0 / 25%);
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
}

export function removeRemoteCursorStyles() {
  document.getElementById('remote-cursor-styles')?.remove();
}
