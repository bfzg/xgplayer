/**
 * UMD entry. The build publishes this object under the `SoftDecode` global,
 * which is one of the two keys the streaming plugins probe, so the whole api is
 * flattened into one plain object rather than left as a module namespace.
 */
import { registerSoftDecode, softDecodeApi } from './register'

try {
  registerSoftDecode()
} catch (_error) {
  // The UMD wrapper has already published the global by the time this runs, so
  // a failure here only costs the second alias.
}

export default {
  ...softDecodeApi,
  registerSoftDecode
}
