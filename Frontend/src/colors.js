export const COLLABORATE_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db',
  '#9b59b6', '#1abc9c', '#e91e63', '#ff9800', '#673ab7',
];

export function colorForName(name = '') {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return COLLABORATE_COLORS[Math.abs(hash) % COLLABORATE_COLORS.length];
}
