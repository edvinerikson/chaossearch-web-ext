import { createElement } from '../elements';
import { makeTextReplacer } from '../replacer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const styles = require('../main.css');

export const highlightTimestamp = makeTextReplacer(
  /(\d{4})-(\d{2})-(\d{2})T([012]\d):([0-6]\d):([0-5]\d)\.\d{3}Z/,
  (fragment: DocumentFragment) : Element => {
    const element = createElement('time', styles.timestamp);

    element.appendChild( fragment.firstChild as Element );

    return element;
  }
);
