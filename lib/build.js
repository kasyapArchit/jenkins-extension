// Bump on any change to the service worker or the modules it imports.
//
// Chrome often keeps a running service worker alive when an unpacked extension
// is reloaded, so the popup can be new code while the worker is old. Both sides
// report the value from their own loaded copy of this module; a mismatch means
// exactly that, and the popup offers to reload the extension for real.
export const BUILD = '3';
