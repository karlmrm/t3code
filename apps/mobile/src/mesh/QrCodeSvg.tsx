import { QrCode } from "@t3tools/shared/qrCode";
import Svg, { Path, Rect } from "react-native-svg";

function pathData(qr: QrCode, margin: number) {
  const commands: Array<string> = [];
  for (let y = 0; y < qr.size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= qr.size; x += 1) {
      if (x < qr.size && qr.getModule(x, y)) {
        if (runStart === -1) runStart = x;
        continue;
      }
      if (runStart === -1) continue;
      commands.push(`M${runStart + margin} ${y + margin}h${x - runStart}v1H${runStart + margin}z`);
      runStart = -1;
    }
  }
  return commands.join("");
}

/** A QR code drawn black on white, so any camera reads it in either theme. */
export function QrCodeSvg(props: { readonly value: string; readonly size: number }) {
  const qr = QrCode.encodeText(props.value, QrCode.Ecc.LOW);
  const extent = qr.size + 2;
  return (
    <Svg width={props.size} height={props.size} viewBox={`0 0 ${extent} ${extent}`}>
      <Rect width={extent} height={extent} fill="#fff" />
      <Path d={pathData(qr, 1)} fill="#000" />
    </Svg>
  );
}
