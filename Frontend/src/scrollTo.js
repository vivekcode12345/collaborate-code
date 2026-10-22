export function scrollToSection(target, id) {
  if (!target) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({
    top: target.getBoundingClientRect().top + window.scrollY - 96,
    behavior: reducedMotion ? 'auto' : 'smooth',
  });
  window.history.replaceState(null, '', `#${id}`);
  target.focus({ preventScroll: true });
}
