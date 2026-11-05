/** Join class names; later Tailwind utilities win in nsh's resolver as they do in CSS order. */
export const cn = (...inputs: (string | false | null | undefined)[]): string => inputs.filter(Boolean).join(' ')
