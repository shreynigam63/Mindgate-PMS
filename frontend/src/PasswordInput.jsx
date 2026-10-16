import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

// Every password box in the app (16 Oct, from the client's QA):
//   - our own Show / Hide button, always there. The browser's reveal eye
//     (Edge) disappears once the box loses focus, which read as broken.
//   - a password cannot be copied or cut out of the box. Pasting stays
//     allowed so password managers keep working.
export default function PasswordInput({ value, onChange, className = 'inp', ...rest }) {
  const [shown, setShown] = useState(false);
  const block = (e) => e.preventDefault();
  return (
    <div className="relative">
      <input {...rest} className={`${className} pr-10 pw-input`} type={shown ? 'text' : 'password'} value={value} onChange={onChange}
        onCopy={block} onCut={block} onDragStart={block} />
      <button type="button" tabIndex={-1} aria-label={shown ? 'Hide password' : 'Show password'} title={shown ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 px-3 flex items-center text-navy-400 hover:text-navy-700"
        onMouseDown={(e) => e.preventDefault()} onClick={() => setShown((v) => !v)}>
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
