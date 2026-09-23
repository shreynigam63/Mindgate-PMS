/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Palette sampled directly from the BRD's reference screenshots (not
      // guessed) — navy/pink/teal/amber/green is the client's own existing
      // design language for this product, kept as the base rather than
      // replaced. "Brand" (pink) is used sparingly and deliberately, as the
      // signature accent — the logo mark, a handful of "forward" actions, and
      // the hero band of the pages where it belongs — not spread across every
      // button, so it stays a genuine signature rather than becoming noise.
      //
      // It is NO LONGER the active-nav indicator. Since 22 Sep the sidebar
      // colours the active item by its group (navy / lagoon / violet / leaf),
      // which is what tells you where you are in a 29-item menu; one accent
      // colour could not carry that. Tailwind's own violet is used for HR and
      // super-admin surfaces, as it already was for the AI panels.
      //
      // THE ACCENT WAS PINK (#ec407a) UNTIL 23 SEP, when the client asked for
      // it gone: "please remove this pink colour from everywhere and replace
      // the same with blue color." It is now an azure blue, chosen to sit
      // clearly apart from the two blues already in the palette — navy is a
      // dark, desaturated slate and lagoon is a teal, so a saturated mid
      // azure still reads as an accent rather than as more chrome.
      //
      // Swapping the hue alone would have QUIETLY CHANGED MEANING, because a
      // few places used the pink to say "this is wrong" — a login error, the
      // Returned tab, the no-manager warning, a "Not yet" verdict — and those
      // read as neutral once the colour is blue. They were moved onto rose
      // and amber2, which is what they should always have used. If you are
      // adding something that means trouble, reach for those, not this.
      colors: {
        navy: { 50: '#eef2f8', 100: '#dbe3ef', 300: '#7d95bb', 400: '#3a5a8c', 500: '#2c4b7c', 600: '#24426e', 700: '#1b3b6f', 800: '#152f59', 900: '#101f3d' },
        brand: { 50: '#eaf2fe', 100: '#cfe1fc', 300: '#7db0f5', 500: '#2f7fe8', 600: '#1765d1', 700: '#1250a6' },
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
