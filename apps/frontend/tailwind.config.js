/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          navy: '#F5F5F4',
          'navy-light': '#EAEAE8',
          amber: '#E8A020',
          'amber-hover': '#D4911A',
        },
        signal: {
          blue: '#2D35B5',
          'blue-light': '#4F56C8',
        },
        surface: '#F9F9F8',
        canvas: '#FFFFFF',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"DM Mono"', 'ui-monospace', 'monospace'],
      }
    }
  },
  plugins: []
}
