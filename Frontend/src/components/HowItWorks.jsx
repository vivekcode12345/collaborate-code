const STEPS = [
  ['Create or join a room', 'Share the link, no signup'],
  ['Code together', 'Live cursors, instant sync, run code in the room'],
  ['Run, replay, review', 'Replay the session or read the interview report'],
];

export default function HowItWorks({ sectionRef }) {
  useEffect(() => {
    const root = sectionRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add('is-visible')), { threshold: .12 });
    root.querySelectorAll('.cc-reveal').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [sectionRef]);
  return <section className="cc-section cc-how-section" id="how" ref={sectionRef} tabIndex="-1">
    <div className="cc-section-heading cc-reveal"><span className="cc-eyebrow">A SIMPLE LOOP</span><h2>How it works</h2></div>
    <div className="cc-steps">{STEPS.map(([title, description], index) => <article className="cc-step cc-reveal" style={{ '--reveal-delay': `${index * 60}ms` }} key={title}><span className="cc-step-number">{index + 1}</span><div><h3>{title}</h3><p>{description}</p></div></article>)}</div>
    <div className="cc-tech-row cc-reveal"><span>Built with</span>{['React', 'Yjs', 'Socket.io', 'Monaco Editor', 'Node.js', 'Express'].map((tech) => <span className="cc-tech-chip" key={tech}>{tech}</span>)}</div>
  </section>;
}
import { useEffect } from 'react';
