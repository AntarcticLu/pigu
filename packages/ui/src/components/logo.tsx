import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 10H4V6H12V10Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V10H12V4ZM16 14H4V20H0V0H16V14Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 50H20V30H60V50Z" fill="var(--icon-base)" />
      <path d="M60 20H20V50H60V20ZM80 70H20V100H0V0H80V70Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 114 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M18 30H6V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M6 30H18V12H6V30ZM24 36H6V42H0V6H24V36Z" fill="var(--icon-strong-base)" />
        <path d="M48 30H36V18H48V30Z" fill="var(--icon-weak-base)" />
        <path d="M48 6H36V0H48V6ZM48 36H36V12H48V36Z" fill="var(--icon-strong-base)" />
        <path d="M78 24H66V18H78V24Z" fill="var(--icon-weak-base)" />
        <path d="M78 12H66V24H78V12ZM84 42H60V36H78V30H60V6H84V42Z" fill="var(--icon-strong-base)" />
        <path d="M108 30H96V18H108V30Z" fill="var(--icon-weak-base)" />
        <path d="M96 6V30H108V6H114V36H90V6H96Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
