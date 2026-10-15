import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-archivo)", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-martian)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Bitcoin orange (#F7931A)
        brand: {
          50: "#fff7ed",
          100: "#ffedd5",
          200: "#fed7aa",
          300: "#fdba74",
          400: "#fba53c",
          500: "#f7931a",
          600: "#e07d0e",
          700: "#b8620b",
          800: "#8f4d0f",
          900: "#743f10",
        },
        surface: {
          DEFAULT: "#0c0a08",
          card: "#151109",
          hover: "#1d1710",
          border: "#2a2016",
        },
        // State tokens named after the mechanic: a flash loan is a circuit
        // that has to close inside one transaction.
        //   trace   : the loan's path (copper; same hue as brand-500)
        //   current : value moving right now
        //   closed  : loop completed: repaid / live
        //   open    : loop broken: reverted / no usable path
        //   tripped : breaker thrown: paused
        circuit: {
          trace: "#f7931a",
          current: "#ffc685",
          closed: "#86dba9",
          open: "#ff6b57",
          tripped: "#f2c94c",
        },
      },
    },
  },
  plugins: [],
};

export default config;
