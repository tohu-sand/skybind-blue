import type { Config } from 'tailwindcss'

export default {
  content: ['./src/client/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Zen Kaku Gothic Antique"', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: '#121316',
        paper: '#f8f3e8',
        accent: '#f05a28',
        accent2: '#0f6aa6',
      },
      boxShadow: {
        frame: '0 25px 60px -40px rgba(12, 12, 18, 0.45)',
      },
      keyframes: {
        'soft-in': {
          '0%': { opacity: '0', transform: 'translateY(10px) scale(0.99)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        breath: {
          '0%, 100%': { opacity: '0.35' },
          '50%': { opacity: '0.9' },
        },
      },
      animation: {
        'soft-in': 'soft-in 650ms ease-out',
        breath: 'breath 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
