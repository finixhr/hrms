// ============ ADMS endpoint: /iclock/cdata (handshake + event push) ============
// (thin proxy — kept at /api/integrations/zkteco/adms/cdata for any
// existing bookmarks/test scripts. The canonical device-facing path is
// /iclock/cdata; see src/app/iclock/cdata/route.ts.)
import { GET, POST } from "@/app/iclock/cdata/route"

export { GET, POST }
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
