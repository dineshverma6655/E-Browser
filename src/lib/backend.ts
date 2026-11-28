// The API lives on the same Vercel deployment as the pages, so every path is relative to the current origin.
export const backendUrl = (path: string): string => path;
