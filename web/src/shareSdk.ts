// The core's share registries ship in @kubuno/sdk. The published types this
// module compiles against do not expose them yet, while the HOST provides them
// at runtime through the import map — so we reach them with a narrow cast.
// Replace this file with a direct import once @kubuno/sdk is published & bumped.
import * as sdk from '@kubuno/sdk'

export interface ShareRecipientKind {
  id:       string
  moduleId: string
  label:    string
  order?:   number
}

export const ShareRecipientKinds = (sdk as unknown as {
  ShareRecipientKinds?: { add: (k: ShareRecipientKind) => void; remove: (id: string) => void }
}).ShareRecipientKinds
