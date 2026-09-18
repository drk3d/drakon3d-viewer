// Shared by the Material panel and imported 3DM render settings. Keeping the
// definitions in one place guarantees that an imported light/dark background
// looks exactly like pressing its corresponding Material-panel preset.
export const BACKGROUND_PRESETS = [
  {
    id: 'light', labelKey: 'materials.background_light', icon: 'assets/materials/background-light.png',
    type: 'gradient2', color1: '#ffffff', color2: '#a0a0a0', spread: 0.5
  },
  {
    id: 'dark', labelKey: 'materials.background_dark', icon: 'assets/materials/background-dark.png',
    type: 'radial', color1: '#121212', color2: '#000000', spread: 1
  },
  {
    id: 'dark-blue', labelKey: 'materials.background_dark_blue', icon: 'assets/materials/background-dark-blue.png',
    type: 'radial', color1: '#020114', color2: '#000000', spread: 1
  }
];
