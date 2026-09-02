/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Palette sampled directly from the BRD's reference screenshots (not
      // guessed) — navy/pink/teal/amber/green is the client's own existing
      // design language for this product, kept as the base rather than
      // replaced. "Brand" (pink) is used sparingly and deliberately, as the
      // signature accent — reserved for the active-nav indicator, the logo
      // mark, and a handful of "forward" actions — not spread across every
      // button, so it stays a genuine signature rather than becoming noise.
      colors: {
        navy: { 50: '#eef2f8', 100: '#dbe3ef', 300: '#7d95bb', 400: '#3a5a8c', 500: '#2c4b7c', 600: '#24426e', 700: '#1b3b6f', 800: '#152f59', 900: '#101f3d' },
        brand: { 50: '#fdf0f5', 100: '#fbdce9', 300: '#f478a8', 500: '#ec407a', 600: '#d42f68', 700: '#ad2454' },
        lagoon: { 50: '#eafbfd', 100: '#c7f0f5', 300: '#5cd3e0', 500: '#17a2b8', 600: '#13859a', 700: '#0f6a7a' },
        amber2: { 50: '#fff6ec', 100: '#ffe6c7', 500: '#f5821f', 600: '#d96b0f' },
        leaf: { 50: '#eef9ee', 100: '#d3f0d5', 500: '#43a047', 600: '#358239' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      backdropBlur: { xs: '2px' },
      boxShadow: {
        glass: '0 1px 1px rgba(16,31,61,0.04), 0 8px 24px -8px rgba(16,31,61,0.12)',
        card: '0 1px 2px rgba(16,31,61,0.04), 0 4px 16px -6px rgba(16,31,61,0.08)',
      },
    },
  },
  plugins: [],
};
