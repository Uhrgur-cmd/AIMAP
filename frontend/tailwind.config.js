/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        plc: {
          green: '#22c55e',
          yellow: '#eab308',
          red: '#ef4444',
          blue: '#3b82f6'
        }
      }
    }
  },
  plugins: []
};
