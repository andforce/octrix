/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#090b10',
          elevated: '#0e1118',
          muted: '#151a24',
          hover: '#1b2130',
        },
        border: {
          DEFAULT: 'rgba(255, 255, 255, 0.07)',
          strong: 'rgba(255, 255, 255, 0.12)',
        },
        accent: {
          DEFAULT: '#ff5f3d',
          hover: '#ff7a5c',
          muted: 'rgba(255, 95, 61, 0.16)',
        },
        mint: {
          DEFAULT: '#4fd1c5',
          dim: 'rgba(79, 209, 197, 0.14)',
        },
        content: {
          DEFAULT: '#ebe8e4',
          muted: '#9c9890',
          subtle: '#6b665e',
        },
      },
      fontFamily: {
        display: ['"Syne"', 'system-ui', 'sans-serif'],
        sans: ['"Bricolage Grotesque"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        panel: '0 24px 48px -12px rgba(0, 0, 0, 0.55)',
        glow: '0 0 48px -8px rgba(255, 95, 61, 0.32)',
        insetHighlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.06)',
      },
      backgroundImage: {
        'mesh':
          'radial-gradient(ellipse 80% 50% at 20% -10%, rgba(255, 95, 61, 0.12), transparent 50%), radial-gradient(ellipse 60% 40% at 100% 0%, rgba(79, 209, 197, 0.08), transparent 45%)',
        'grid-subtle':
          'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '32px 32px',
      },
      animation: {
        'fade-in': 'fadeIn 0.55s ease-out forwards',
        'fade-in-slow': 'fadeIn 0.75s ease-out forwards',
        'slide-up': 'slideUp 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards',
        'pulse-soft': 'pulseSoft 3.5s ease-in-out infinite',
        /** 忙碌（琥珀色）状态指示：呼吸闪烁，表示 AI 正在工作 */
        'presence-busy': 'presenceBusyBlink 1.1s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%': { opacity: '0.85', transform: 'scale(1.02)' },
        },
        presenceBusyBlink: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)', filter: 'brightness(1)' },
          '50%': { opacity: '0.42', transform: 'scale(0.92)', filter: 'brightness(0.88)' },
        },
      },
    },
  },
  plugins: [],
};
