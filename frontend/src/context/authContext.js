import { createContext } from 'react'

// Parallel to historyContext.js / playerContext.js: the bare context object lives
// in a .js file (no component export) so React Fast Refresh / Biome's
// useComponentExportOnlyModules rule stays happy. The provider (AuthContext.jsx)
// and the hook (useAuth.js) are separate files.
export const AuthContext = createContext(null)
