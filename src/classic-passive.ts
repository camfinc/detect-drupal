// Injectable classic script without network access: registers window.detectDrupal (passive + cached depths).
import { detectDrupal } from "./passive-only";
import { setGlobal } from "./set-global";

setGlobal(detectDrupal);
