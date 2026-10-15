/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          50:  "rgb(var(--surface-50) / <alpha-value>)",
          100: "rgb(var(--surface-100) / <alpha-value>)",
          200: "rgb(var(--surface-200) / <alpha-value>)",
          800: "rgb(var(--surface-800) / <alpha-value>)",
          900: "rgb(var(--surface-900) / <alpha-value>)",
          950: "rgb(var(--surface-950) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          soft:    "rgb(var(--accent-soft) / <alpha-value>)",
          dim:     "rgb(var(--accent-dim) / <alpha-value>)",
        },
        success: "rgb(var(--success) / <alpha-value>)",
        warn:    "rgb(var(--warn) / <alpha-value>)",
        danger:  "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Segoe UI", "SF Pro Text", "system-ui", "sans-serif"],
        mono: ["Cascadia Mono", "Consolas", "ui-monospace", "monospace"],
      },
      animation: {
        "slide-in":   "slideIn 0.2s ease-out",
        "fade-in":    "fadeIn 0.15s ease-out",
        "pulse-soft": "pulseSoft 2s infinite",
      },
      keyframes: {
        slideIn:    { from: { transform: "translateX(-8px)", opacity: 0 }, to: { transform: "translateX(0)", opacity: 1 } },
        fadeIn:     { from: { opacity: 0 }, to: { opacity: 1 } },
        pulseSoft:  { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.5 } },
      },
    },
  },
  plugins: [],
};
