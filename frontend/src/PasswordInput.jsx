import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// Every password box in the app (16 Oct, from the client's QA):
//   - our own Show / Hide button, always there. The browser's reveal eye
//     (Edge) disappears once the box loses focus, which read as broken.
//   - a password is typed by hand: it cannot be copied, cut, pasted or
//     dropped into or out of the box (Def-017; the client's follow-up:
//     "pasting should not be allowed, only hand typed"). The box says so
//     when someone tries, rather than seeming to ignore them. A browser's
//     own saved-password fill is not a paste and still works.
export default function PasswordInput({ value, onChange, className = 'inp', ...rest }) {
  const [shown, setShown] = useState(false);
  const [hint, setHint] = useState(null);
  const block = (what) => (e) => { e.preventDefault(); setHint(what); };
  return (
    <div>
      <div className="relative">
        <input {...rest} className={`${className} pr-10 pw-input`} type={shown ? 'text' : 'password'} value={value}
          onChange={(e) => { setHint(null); onChange(e); }}
          onCopy={block('A password cannot be copied.')} onCut={block('A password cannot be copied.')}
          onPaste={block('Type the password — pasting is turned off.')} onDrop={block('Type the password — pasting is turned off.')}
          onDragStart={(e) => e.preventDefault()} />
        <button type="button" tabIndex={-1} aria-label={shown ? 'Hide password' : 'Show password'} title={shown ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 px-3 flex items-center text-navy-400 hover:text-navy-700"
          onMouseDown={(e) => e.preventDefault()} onClick={() => setShown((v) => !v)}>
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {hint && <p className="text-[11px] text-amber-700 mt-1" role="status">{hint}</p>}
    </div>
  );
}
