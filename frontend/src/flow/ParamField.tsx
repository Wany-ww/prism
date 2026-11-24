import { AutoComplete, Input, InputNumber, Select, Switch } from 'antd';
import type { ParamSpec } from '../api';

export function colOptions(cols: string[]) {
  return cols.map((c) => ({ value: c, label: c }));
}

export default function ParamField({
  spec,
  value,
  onChange,
  columns,
}: {
  spec: ParamSpec;
  value: any;
  onChange: (v: any) => void;
  columns: string[];
}) {
  switch (spec.type) {
    case 'text':
      return <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 10 }} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={spec.help} />;
    case 'number':
      return <InputNumber style={{ width: '100%' }} value={value} onChange={onChange} />;
    case 'boolean':
      return <Switch checked={!!value} onChange={onChange} />;
    case 'select':
      return <Select value={value} onChange={onChange} options={(spec.options ?? []).map((o) => ({ value: o, label: o }))} style={{ width: '100%' }} />;
    case 'column':
      return (
        <AutoComplete
          value={value ?? ''}
          onChange={onChange}
          options={colOptions(columns)}
          filterOption={(i, o) => String(o?.value).toLowerCase().includes(i.toLowerCase())}
          placeholder="컬럼 선택/입력"
          allowClear
        />
      );
    case 'columns':
      return (
        <Select
          mode="tags"
          value={value ?? []}
          onChange={onChange}
          options={colOptions(columns)}
          placeholder="컬럼 선택 (직접 입력 가능)"
          style={{ width: '100%' }}
          tokenSeparators={[',']}
        />
      );
    case 'json':
      return (
        <Input.TextArea
          className="mono"
          autoSize={{ minRows: 2, maxRows: 10 }}
          defaultValue={JSON.stringify(value ?? null, null, 2)}
          onBlur={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              /* keep previous */
            }
          }}
        />
      );
    default:
      return <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={spec.help} />;
  }
}
