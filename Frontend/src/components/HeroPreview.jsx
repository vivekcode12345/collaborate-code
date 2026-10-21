import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from './ui';
import { colorForName } from '../colors';

const LINES = [
  ['Ada', 'function', 'twoSum(nums, target) {'],
  ['Linus', 'comment', '  // Find the matching complement'],
  ['Ada', 'keyword', '  const seen = new Map();'],
  ['Linus', 'keyword', '  for (let i = 0; i < nums.length; i++) {'],
  ['Ada', 'keyword', '    const need = target - nums[i];'],
  ['Linus', 'keyword', '    if (seen.has(need)) return [seen.get(need), i];'],
  ['Ada', 'function', '    seen.set(nums[i], i);'],
  ['Linus', 'plain', '  }'],
  ['Ada', 'plain', '}'],
];

function syntax(text) {
  const pattern = /(\/\/.*|"[^"]*"|\b(?:function|const|for|let|if|return|new)\b|\b\d+\b|\b[A-Za-z_$][\w$]*(?=\s*\())/g;
  const nodes = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(<span key={`${last}-plain`}>{text.slice(last, match.index)}</span>);
    const value = match[0];
    const type = value.startsWith('//') ? 'comment' : value.startsWith('"') ? 'string' : /^\d+$/.test(value) ? 'number' : /^(function|const|for|let|if|return|new)$/.test(value) ? 'keyword' : 'function';
    nodes.push(<span className={`cc-syn-${type}`} key={`${match.index}-${type}`}>{value}</span>);
    last = match.index + value.length;
  }
  if (last < text.length) nodes.push(<span key={`${last}-tail`}>{text.slice(last)}</span>);
  return nodes;
}

export default function HeroPreview() {
  const initialReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [visible, setVisible] = useState(() => initialReduced ? LINES.map((line) => line[2]) : LINES.map(() => ''));
  const [cursors, setCursors] = useState(() => initialReduced
    ? [{ line: 4, column: LINES[4][2].length }, { line: 7, column: LINES[7][2].length }]
    : [{ line: 0, column: 0 }, { line: 1, column: 0 }]);
  const [finished, setFinished] = useState(initialReduced);
  const [reduced, setReduced] = useState(initialReduced);
  const [paused, setPaused] = useState(false);
  const timer = useRef(null);
  const scheduleRef = useRef(null);
  const index = useRef(0);
  const character = useRef(0);
  const element = useRef(null);

  const clearTimer = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const schedule = useCallback((delay) => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (paused || document.hidden || !element.current?.dataset.visible) return;
      const [, , text] = LINES[index.current];
      character.current += 1;
      setVisible((lines) => lines.map((line, lineIndex) => lineIndex === index.current ? text.slice(0, character.current) : line));
      const userIndex = LINES[index.current][0] === 'Ada' ? 0 : 1;
      setCursors((positions) => positions.map((position, cursorIndex) => cursorIndex === userIndex
        ? { line: index.current, column: character.current }
        : position));
      if (character.current >= text.length) {
        if (index.current === LINES.length - 1) {
          setFinished(true);
          timer.current = window.setTimeout(() => {
            index.current = 0; character.current = 0; setVisible(LINES.map(() => '')); setFinished(false); setCursors([{ line: 0, column: 0 }, { line: 1, column: 0 }]); scheduleRef.current?.(400);
          }, 1800);
          return;
        }
        index.current += 1; character.current = 0; scheduleRef.current?.(120);
      } else scheduleRef.current?.(30 + Math.floor(Math.random() * 31));
    }, delay);
  }, [clearTimer, paused]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
      setReduced(media.matches);
      if (media.matches) {
        clearTimer();
        setVisible(LINES.map((line) => line[2]));
        setFinished(true);
      setCursors([{ line: 4, column: LINES[4][2].length }, { line: 7, column: LINES[7][2].length }]);
      }
    };
    media.addEventListener?.('change', updateMotion);
    const observer = new IntersectionObserver(([entry]) => setPaused(!entry.isIntersecting), { threshold: 0.05 });
    if (element.current) observer.observe(element.current);
    const visibility = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', visibility);
    scheduleRef.current = schedule;
    if (!media.matches) schedule(500);
    return () => { clearTimer(); observer.disconnect(); media.removeEventListener?.('change', updateMotion); document.removeEventListener('visibilitychange', visibility); };
  }, [clearTimer, schedule]);

  useEffect(() => {
    if (!paused && !reduced && !timer.current) schedule(200);
  }, [paused, reduced, schedule]);

  const displayLines = reduced ? LINES.map((line) => line[2]) : visible;
  return <div className="cc-hero-preview" ref={element} data-visible="true" aria-hidden="true">
    <div className="cc-preview-window">
      <div className="cc-preview-titlebar"><span className="cc-preview-dots"><i /><i /><i /></span><span className="cc-preview-file">solution.js</span><span className="cc-preview-people"><Avatar name="Ada" /><Avatar name="Linus" /></span></div>
      <div className="cc-preview-code">{displayLines.map((line, lineIndex) => {
        const cursor = cursors.find((position) => position.line === lineIndex);
        const owner = cursor ? LINES[cursor.line][0] : null;
        return <div className="cc-preview-line" key={lineIndex}><span className="cc-line-number">{lineIndex + 1}</span><span className="cc-line-code">{syntax(line)}{cursor && <span className="cc-preview-caret" style={{ backgroundColor: colorForName(owner) }}><b style={{ backgroundColor: colorForName(owner) }}>{owner}</b></span>}</span></div>;
      })}</div>
      <div className={`cc-preview-output ${finished ? 'visible' : ''}`}>✓ Output: 42</div>
    </div>
  </div>;
}
