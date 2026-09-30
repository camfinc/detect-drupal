// Classic <script> / injectable entry, passive only: registers window.detectDrupal, no network code.
import { detectDrupal } from "./passive-only";
import { setGlobal } from "./set-global";

setGlobal(detectDrupal);
