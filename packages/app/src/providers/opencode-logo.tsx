export function OpenCodeLogo(props: { class?: string }) {
  return (
    <svg
      data-component="opencode-logo"
      aria-hidden="true"
      class={props.class}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(1.2 1.2) scale(0.85)">
        <path opacity="0.2" d="M11.2 8H4.8V4.8H11.2V8Z" fill="currentColor" />
        <path d="M11.2 3.2H4.8V8H11.2V3.2ZM14.4 11.2H4.8V16H1.6V0H14.4V11.2Z" fill="currentColor" />
      </g>
    </svg>
  )
}
