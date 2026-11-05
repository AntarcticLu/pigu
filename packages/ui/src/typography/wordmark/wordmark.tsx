import { createUniqueId, type ComponentProps } from "solid-js"

export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 114 42"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_path]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} class="[[data-color-scheme=dark]_&]:opacity-100">
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <g
            opacity={props.muted === false ? 1 : 0.16 * 0.7}
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            <path
              pathLength={props.outline ? 1 : undefined}
              d="M6 30H18V12H6V30ZM24 36H6V42H0V6H24V36Z"
            />
            <path
              pathLength={props.outline ? 1 : undefined}
              d="M48 6H36V0H48V6ZM48 36H36V12H48V36Z"
            />
            <path
              pathLength={props.outline ? 1 : undefined}
              d="M78 12H66V24H78V12ZM84 42H60V36H78V30H60V6H84V42Z"
            />
            <path
              pathLength={props.outline ? 1 : undefined}
              d="M96 6V30H108V6H114V36H90V6H96Z"
            />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="114" height="42">
          <rect width="114" height="42" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="57" y1="22" x2="57" y2="42" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
