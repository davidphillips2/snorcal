import { parseGcode } from './gcode-parser';

self.onmessage = (e: MessageEvent<string>) => {
  const result = parseGcode(e.data);
  self.postMessage(result);
};
