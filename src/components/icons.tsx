export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    alerts: "M12 3 2 20h20L12 3zM12 10v4M12 17h.01",
    incidents: "M12 3 2 8l10 5 10-5-10-5zM2 16l10 5 10-5M2 12l10 5 10-5",
    presets: "M3 5h18l-7 8v6l-4-2v-4L3 5z",
    "correlation-rules":
      "M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1",
    maintenance: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    dashboards: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    operators: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
    search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6",
    arrow: "M5 12h14M13 6l6 6-6 6",
    plus: "M12 5v14M5 12h14",
    edit: "M16 3l5 5M3 21l4-1L21 6l-4-4L3 16v5z",
    view: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
    resolve: "M21 11.1V12a9 9 0 1 1-5.3-8.2M21 4.5 12 13.5l-3-3",
    reopen: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
    assign: "M19 21a7 7 0 0 0-14 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    link: "M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
    undo: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
    external:
      "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-5v2m0 14v2m9-9h-2M5 12H3m15.36-6.36-1.42 1.42M7.06 16.94l-1.42 1.42m12.72 0-1.42-1.42M7.06 7.06 5.64 5.64",
    moon: "M20.8 13.5A9 9 0 0 1 10.5 3.2 9 9 0 1 0 20.8 13.5Z",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.alerts} />
    </svg>
  );
}
