import { useCallback, useEffect, useState } from 'react';

function preferredTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function useTheme() {
  const [theme, setTheme] = useState(preferredTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((value) => value === 'dark' ? 'light' : 'dark'), []);
  return { theme, toggle };
}
