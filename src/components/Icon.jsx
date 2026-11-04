const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  up: 'M6 16 16 6M6 6h10v10',
  down: 'm6 8 10 10M6 18h10V8',
  clock: 'M12 8v5l3 2',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1',
  check: 'm5 12 4 4L19 6',
  info: 'M12 11v6m0-10v.01',
};

export default function Icon({ name, size = 18, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {['clock', 'info'].includes(name) && <circle cx="12" cy="12" r="9" />}
      <path d={paths[name] || paths.activity} />
    </svg>
  );
}
