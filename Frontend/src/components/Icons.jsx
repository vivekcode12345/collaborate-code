const icon = (children, props = {}) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="18" height="18" aria-hidden="true" {...props}>{children}</svg>;
export const SunIcon = (props) => icon(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></>, props);
export const MoonIcon = (props) => icon(<path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5Z" />, props);
export const CopyIcon = (props) => icon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, props);
export const MenuIcon = (props) => icon(<path d="M4 6h16M4 12h16M4 18h16" />, props);
export const PlayIcon = (props) => icon(<path d="m8 5 11 7-11 7V5Z" />, props);
export const CodeIcon = (props) => icon(<><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14" /></>, props);
export const CursorIcon = (props) => icon(<><path d="M5 3v15l4-4 3 6 2-1-3-6h6L5 3Z" /></>, props);
export const ReplayIcon = (props) => icon(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>, props);
