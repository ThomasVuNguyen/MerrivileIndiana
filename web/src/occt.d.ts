declare module 'occt-import-js' {
  const occtimportjs: (opts?: { locateFile?: (path: string) => string }) => Promise<{
    ReadStepFile: (content: Uint8Array, params: unknown) => { success: boolean; meshes: any[] }
  }>
  export default occtimportjs
}
