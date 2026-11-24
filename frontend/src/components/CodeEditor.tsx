import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { useTheme } from '../theme';

const extensions = [python()];

export default function CodeEditor({
  value,
  onChange,
  height = '420px',
  readOnly,
}: {
  value: string;
  onChange?: (v: string) => void;
  height?: string;
  readOnly?: boolean;
}) {
  const { mode } = useTheme();
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
      <CodeMirror
        value={value}
        height={height}
        theme={mode}
        extensions={extensions}
        onChange={onChange}
        readOnly={readOnly}
        basicSetup={{ tabSize: 4, foldGutter: true, highlightActiveLine: true }}
        style={{ fontSize: 13 }}
      />
    </div>
  );
}
