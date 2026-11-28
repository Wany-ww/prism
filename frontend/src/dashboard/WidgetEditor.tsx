import { Alert, AutoComplete, Button, Col, Divider, Form, Input, InputNumber, Modal, Radio, Row, Select, Slider, Space, Switch, Tooltip, Typography, Upload } from 'antd';
import type { DefaultOptionType } from 'antd/es/select';
import { DeleteOutlined, MinusCircleOutlined, PictureOutlined, PlusOutlined } from '@ant-design/icons';
import { useMemo, useState } from 'react';
import type { Dataset } from '../api';
import { AXIS_BG_KINDS, BG_DEFAULTS, bgUnit, BgUnit, ChartBackground, dataUrlBytes, readImageFile } from './background';
import { ChartKind, neededColumns } from './charts';
import { Layer, paramIdOf, paramToken } from './link';
import { canHighlight, ControlOption, Widget } from './Widget';

const KINDS: { value: ChartKind; label: string }[] = [
  { value: 'line', label: 'Line (trend)' },
  { value: 'area', label: 'Area' },
  { value: 'bar', label: 'Bar' },
  { value: 'scatter', label: 'Scatter (correlation)' },
  { value: 'xy', label: 'XY position' },
  { value: 'histogram', label: 'Histogram (distribution)' },
  { value: 'box', label: 'Box plot' },
  { value: 'heatmap', label: 'Heatmap (matrix)' },
  { value: 'pie', label: 'Donut (share)' },
  { value: 'scatter3d', label: '3D scatter' },
];

export default function WidgetEditor({
  value,
  datasets,
  paramIds,
  onOk,
  onCancel,
}: {
  value: Widget;
  datasets: Dataset[];
  /** 지금 편집 중인 위젯을 뺀, 대시보드의 다른 컨트롤 위젯들의 paramId — 차트 등에서 "⚙ 파라미터"로 고를 수 있게 하고,
   * 이 위젯 자신이 컨트롤이면 같은 이름이 이미 쓰이고 있는지 확인하는 데도 씀 */
  paramIds: string[];
  onOk: (w: Widget) => void;
  onCancel: () => void;
}) {
  const [w, setW] = useState<Widget>(value);
  const ds = datasets.find((d) => d.name === w.dataset);
  const colsOf = (name?: string) => (datasets.find((d) => d.name === name)?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name}  ·  ${c.dtype}` }));
  const paramOpts = [...new Set(paramIds)].map((id) => ({ value: paramToken(id), label: `⚙ ${id}` }));
  /** 컬럼 목록에 "⚙ 파라미터" 선택지를 더함 (컨트롤 위젯이 있을 때만) */
  const withParams = (base: DefaultOptionType[]): DefaultOptionType[] => (paramOpts.length ? [{ label: 'Columns', options: base }, { label: 'Parameters', options: paramOpts }] : base);
  const rawCols = colsOf(w.dataset);
  const cols = withParams(rawCols);
  const numCols = withParams((ds?.columns ?? []).filter((c) => c.dtype === 'number').map((c) => ({ value: c.name, label: c.name })));
  const allColNames = useMemo(() => [...new Set(datasets.flatMap((d) => d.columns.map((c) => c.name)))], [datasets]);
  const colSuggest = useMemo(() => allColNames.map((c) => ({ value: c })), [allColNames]);
  const chart = w.chart ?? { kind: 'line' as ChartKind, y: [] };
  const setChart = (p: Partial<typeof chart>) => setW({ ...w, chart: { ...chart, ...p } });
  const spec = chart.spec ?? {};
  const setSpec = (p: Partial<typeof spec>) => setChart({ spec: { ...spec, ...p } });
  const kind = chart.kind;
  const layers = w.layers ?? [];
  const setLayer = (i: number, p: Partial<Layer>) => setW({ ...w, layers: layers.map((l, j) => (j === i ? { ...l, ...p } : l)) });

  // 겹친 데이터셋에서 대응시켜야 하는 컬럼 (위젯이 쓰는 컬럼 + 선택/연동 컬럼). 파라미터 토큰(⚙)은
  // 실행 중에 실제 컬럼명으로 바뀐 뒤에만 알 수 있으므로 여기서는 제외.
  const used = [...new Set([...neededColumns(w), w.type === 'table' ? w.select?.column : undefined, w.link?.mode === 'column' ? w.link.column : undefined].filter(Boolean) as string[])].filter(
    (c) => paramIdOf(c) === null,
  );
  const isXY = w.type === 'chart' && kind === 'xy';
  const is3D = w.type === 'chart' && kind === 'scatter3d';
  const limits = chart.limits ?? {};
  const setLimits = (p: Partial<typeof limits>) => setChart({ limits: { ...limits, ...p } });
  const ctrlOptions = w.control?.options ?? [];
  const setControlOptions = (options: ControlOption[]) => setW({ ...w, control: { ...w.control, options } });
  const paramId = (w.control?.paramId ?? '').trim();
  const paramIdBad = !!paramId && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(paramId);
  // paramIds 는 '다른' 컨트롤 위젯들의 이름이라, 여기 있으면 곧 이름이 겹친다는 뜻
  const paramIdDup = !!paramId && !paramIdBad && paramIds.includes(paramId);

  return (
    <Modal open width={760} title="Widget settings" onOk={() => onOk(w)} onCancel={onCancel} okText="Apply" destroyOnClose styles={{ body: { maxHeight: '72vh', overflowY: 'auto', paddingRight: 8 } }}>
      <Form layout="vertical" size="middle">
        <Row gutter={12}>
          <Col span={24}>
            <Form.Item label="Title">
              <Input value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={24}>
            <Form.Item label="Type">
              <Radio.Group
                value={w.type}
                optionType="button"
                onChange={(e) => {
                  const t = e.target.value;
                  setW({ ...w, type: t, control: t === 'control' ? w.control ?? { kind: 'dropdown', options: [{ label: '', value: '' }] } : w.control });
                }}
                options={[
                  { value: 'chart', label: 'Chart' },
                  { value: 'table', label: 'Table' },
                  { value: 'stat', label: 'Stat' },
                  { value: 'text', label: 'Text' },
                  { value: 'control', label: 'Control' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        {w.type !== 'text' && w.type !== 'control' && (
          <>
            <Row gutter={12}>
              <Col span={layers.length ? 15 : 24}>
                <Form.Item label="Dataset">
                  <Select
                    showSearch
                    value={w.dataset}
                    onChange={(v) => setW({ ...w, dataset: v })}
                    options={datasets.map((d) => ({ value: d.name, label: `${d.name}  (${d.row_count.toLocaleString()} rows)` }))}
                  />
                </Form.Item>
              </Col>
              {layers.length > 0 && (
                <Col span={9}>
                  <Form.Item label="Label">
                    <Input placeholder={w.dataset} value={w.label} onChange={(e) => setW({ ...w, label: e.target.value })} />
                  </Form.Item>
                </Col>
              )}
            </Row>
            {layers.map((l, i) => {
              const lcols = colsOf(l.dataset);
              const names = new Set(lcols.map((c) => c.value));
              return (
                <div key={i} className="layer-box">
                  <Row gutter={12} align="bottom">
                    <Col span={15}>
                      <Form.Item label={`Overlay dataset ${i + 2}`} style={{ marginBottom: 8 }}>
                        <Select
                          showSearch
                          value={l.dataset}
                          onChange={(v) => setLayer(i, { dataset: v, map: {} })}
                          options={datasets.map((d) => ({ value: d.name, label: `${d.name}  (${d.row_count.toLocaleString()} rows)` }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={7}>
                      <Form.Item label="Label" style={{ marginBottom: 8 }}>
                        <Input placeholder={l.dataset} value={l.label} onChange={(e) => setLayer(i, { label: e.target.value })} />
                      </Form.Item>
                    </Col>
                    <Col span={2}>
                      <Form.Item style={{ marginBottom: 8 }}>
                        <Button type="text" icon={<MinusCircleOutlined />} onClick={() => setW({ ...w, layers: layers.filter((_, j) => j !== i) })} />
                      </Form.Item>
                    </Col>
                  </Row>
                  {l.dataset && used.length > 0 && (
                    <div className="layer-map">
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Column mapping — 이름이 같으면 자동, 다르면 이 데이터셋의 컬럼을 고르세요
                      </Typography.Text>
                      {used.map((c) => {
                        const cur = l.map?.[c] || (names.has(c) ? c : undefined);
                        return (
                          <Row key={c} gutter={8} align="middle" style={{ marginTop: 6 }}>
                            <Col span={10} className="ellipsis" style={{ fontSize: 13 }}>
                              {c}
                            </Col>
                            <Col span={14}>
                              <Select
                                size="small"
                                showSearch
                                allowClear
                                style={{ width: '100%' }}
                                status={cur ? undefined : 'warning'}
                                placeholder="None (empty in this dataset)"
                                value={cur}
                                options={lcols}
                                onChange={(v) => setLayer(i, { map: { ...l.map, [c]: v ?? '' } })}
                              />
                            </Col>
                          </Row>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <Button size="small" icon={<PlusOutlined />} onClick={() => setW({ ...w, layers: [...layers, { dataset: w.dataset ?? '', map: {} }] })} style={{ marginBottom: 16 }}>
              Overlay dataset
            </Button>
            {layers.length > 0 && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -8 }}>
                같은 컬럼명끼리 합쳐 한 위젯에 표시하고, 데이터셋별로 색을 나눕니다 (테이블에는 <code>_dataset</code> 컬럼).
              </Typography.Paragraph>
            )}
          </>
        )}
        {w.type === 'chart' && (
          <>
            <Form.Item label="Chart">
              <Select value={kind} options={KINDS} onChange={(v) => setChart({ kind: v, ...(v === 'xy' || v === 'scatter3d' ? { y: (chart.y ?? []).slice(0, 1) } : {}) })} />
            </Form.Item>
            {isXY ? (
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="X position">
                    <Select allowClear showSearch value={chart.x} options={numCols} onChange={(v) => setChart({ x: v })} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="Y position">
                    <Select allowClear showSearch value={chart.y?.[0]} options={numCols} onChange={(v) => setChart({ y: v ? [v] : [] })} />
                  </Form.Item>
                </Col>
              </Row>
            ) : is3D ? (
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item label="X">
                    <Select allowClear showSearch value={chart.x} options={numCols} onChange={(v) => setChart({ x: v })} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="Y">
                    <Select allowClear showSearch value={chart.y?.[0]} options={numCols} onChange={(v) => setChart({ y: v ? [v] : [] })} />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="Z">
                    <Select allowClear showSearch value={chart.z} options={numCols} onChange={(v) => setChart({ z: v })} />
                  </Form.Item>
                </Col>
              </Row>
            ) : (
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label={kind === 'heatmap' ? 'Row label column' : kind === 'box' ? 'Group (X, optional)' : kind === 'pie' ? 'Category column' : kind === 'histogram' ? 'Value column' : 'X axis'}>
                    <Select allowClear showSearch value={chart.x} options={cols} onChange={(v) => setChart({ x: v })} />
                  </Form.Item>
                </Col>
                {kind !== 'histogram' && (
                  <Col span={12}>
                    <Form.Item label={kind === 'heatmap' ? 'Value columns (empty = all numeric)' : kind === 'pie' ? 'Value (empty = count)' : 'Y values'}>
                      <Select mode="multiple" value={chart.y ?? []} options={numCols} maxCount={kind === 'pie' ? 1 : undefined} onChange={(v) => setChart({ y: v })} />
                    </Form.Item>
                  </Col>
                )}
              </Row>
            )}
            <Row gutter={12}>
              {['line', 'area', 'bar', 'scatter', 'xy', 'histogram', 'scatter3d'].includes(kind) && (
                <Col span={12}>
                  <Form.Item label="Series (color by)" extra={isXY || is3D ? '예: 설비별로 색 구분' : 'Y 가 1개일 때 이 컬럼 값별로 나눠 표시'}>
                    <Select allowClear showSearch value={chart.series} options={cols} onChange={(v) => setChart({ series: v })} />
                  </Form.Item>
                </Col>
              )}
              {(kind === 'scatter' || isXY || is3D) && (
                <Col span={12}>
                  <Form.Item label="Tooltip column" extra="점에 마우스를 올리면 함께 보여줌 (예: VAID)">
                    <Select allowClear showSearch value={chart.tip} options={cols} onChange={(v) => setChart({ tip: v })} />
                  </Form.Item>
                </Col>
              )}
              {['line', 'area', 'bar', 'pie'].includes(kind) && (
                <Col span={6}>
                  <Form.Item label="Aggregate">
                    <Select
                      value={chart.agg ?? 'none'}
                      onChange={(v) => setChart({ agg: v })}
                      options={['none', 'mean', 'sum', 'count', 'min', 'max'].map((a) => ({ value: a, label: a === 'none' ? 'raw' : a }))}
                    />
                  </Form.Item>
                </Col>
              )}
              {kind === 'bar' && (
                <Col span={6}>
                  <Form.Item label="Sort">
                    <Select value={chart.sort ?? 'none'} onChange={(v) => setChart({ sort: v })} options={[{ value: 'none', label: 'None' }, { value: 'desc', label: 'Largest first' }, { value: 'asc', label: 'Smallest first' }]} />
                  </Form.Item>
                </Col>
              )}
              {['line', 'area', 'bar'].includes(kind) && (
                <Col span={6}>
                  <Form.Item label="Stacked">
                    <Switch checked={!!chart.stack} onChange={(v) => setChart({ stack: v })} />
                  </Form.Item>
                </Col>
              )}
              {kind === 'scatter' && (
                <Col span={6}>
                  <Form.Item label="Trend line">
                    <Switch checked={!!chart.trendline} onChange={(v) => setChart({ trendline: v })} />
                  </Form.Item>
                </Col>
              )}
              {kind === 'histogram' && (
                <Col span={6}>
                  <Form.Item label="Bins">
                    <InputNumber min={2} max={200} value={chart.bins ?? 20} onChange={(v) => setChart({ bins: v ?? 20 })} />
                  </Form.Item>
                </Col>
              )}
            </Row>
            {kind === 'histogram' && (
              <Form.Item label="Process capability (Cp/Cpk)" extra="규격 하한(LSL)·상한(USL)을 하나 이상 넣으면 히스토그램에 규격선과 Cp/Cpk 가 표시됩니다. 하나만 넣으면 그쪽 규격만(편측) 계산">
                <Space wrap>
                  <InputNumber addonBefore="LSL" step={0.001} value={limits.lsl} onChange={(v) => setLimits({ lsl: v })} style={{ width: 170 }} />
                  <InputNumber addonBefore="USL" step={0.001} value={limits.usl} onChange={(v) => setLimits({ usl: v })} style={{ width: 170 }} />
                </Space>
              </Form.Item>
            )}
            {isXY && (
              <>
                <Row gutter={12}>
                  <Col span={8}>
                    <Form.Item label="Equal axes (1:1)" extra="실제 위치 모양 그대로">
                      <Switch checked={chart.equal ?? true} onChange={(v) => setChart({ equal: v })} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="Show centroid (+)">
                      <Switch checked={chart.centroid ?? true} onChange={(v) => setChart({ centroid: v })} />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item label="Target · tolerance" extra="범위를 벗어난 점은 ▲ 로 표시하고 개수를 보여줍니다">
                  <Radio.Group
                    value={spec.shape ?? 'none'}
                    optionType="button"
                    onChange={(e) => setSpec({ shape: e.target.value })}
                    options={[
                      { value: 'none', label: 'None' },
                      { value: 'circle', label: 'Circle (radius)' },
                      { value: 'rect', label: 'Rectangle (±X, ±Y)' },
                    ]}
                  />
                </Form.Item>
                {(spec.shape ?? 'none') !== 'none' && (
                  <Space wrap style={{ marginBottom: 16 }}>
                    <InputNumber addonBefore="Center X" step={0.001} value={spec.cx} onChange={(v) => setSpec({ cx: v })} style={{ width: 170 }} />
                    <InputNumber addonBefore="Center Y" step={0.001} value={spec.cy} onChange={(v) => setSpec({ cy: v })} style={{ width: 170 }} />
                    {spec.shape === 'circle' ? (
                      <InputNumber addonBefore="Radius" min={0} step={0.001} value={spec.r} onChange={(v) => setSpec({ r: v })} style={{ width: 170 }} />
                    ) : (
                      <>
                        <InputNumber addonBefore="±X" min={0} step={0.001} value={spec.dx} onChange={(v) => setSpec({ dx: v })} style={{ width: 140 }} />
                        <InputNumber addonBefore="±Y" min={0} step={0.001} value={spec.dy} onChange={(v) => setSpec({ dy: v })} style={{ width: 140 }} />
                      </>
                    )}
                  </Space>
                )}
              </>
            )}
            <Divider style={{ margin: '4px 0 14px' }} />
            <BackgroundForm kind={kind} value={chart.background} onChange={(background) => setChart({ background })} />
          </>
        )}
        {w.type === 'table' && (
          <>
            <Row gutter={12}>
              <Col span={18}>
                <Form.Item label="Columns (empty = all)">
                  <Select mode="multiple" value={w.table?.columns ?? []} options={cols} onChange={(v) => setW({ ...w, table: { ...w.table, columns: v } })} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="Rows per page">
                  <InputNumber min={5} max={500} value={w.table?.pageSize ?? 20} onChange={(v) => setW({ ...w, table: { ...w.table, pageSize: v ?? 20 } })} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="Value to select on row click" extra="행을 클릭하면 이 컬럼 값으로 다른 위젯이 바뀝니다 (예: VAID). 비우면 클릭 선택 안 함">
              <Select allowClear showSearch placeholder="No selection" value={w.select?.column} options={cols} onChange={(v) => setW({ ...w, select: v ? { column: v } : undefined })} />
            </Form.Item>
          </>
        )}
        {w.type === 'stat' && (
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item label="Column">
                <Select allowClear showSearch value={w.stat?.column} options={cols} onChange={(v) => setW({ ...w, stat: { ...w.stat, column: v } })} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="Calculation">
                <Select
                  value={w.stat?.agg ?? 'count'}
                  onChange={(v) => setW({ ...w, stat: { ...w.stat, agg: v } })}
                  options={[
                    { value: 'count', label: 'Count' },
                    { value: 'distinct', label: 'Distinct count' },
                    { value: 'mean', label: 'Mean' },
                    { value: 'sum', label: 'Sum' },
                    { value: 'min', label: 'Min' },
                    { value: 'max', label: 'Max' },
                    { value: 'last', label: 'Last value' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="Decimals">
                <InputNumber min={0} max={6} value={w.stat?.decimals ?? 0} onChange={(v) => setW({ ...w, stat: { ...w.stat, decimals: v ?? 0 } })} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="Unit">
                <Input value={w.stat?.suffix} onChange={(e) => setW({ ...w, stat: { ...w.stat, suffix: e.target.value } })} />
              </Form.Item>
            </Col>
          </Row>
        )}
        {w.type === 'text' && (
          <Form.Item label="Content">
            <Input.TextArea autoSize={{ minRows: 4 }} value={w.text?.content} onChange={(e) => setW({ ...w, text: { content: e.target.value } })} />
          </Form.Item>
        )}
        {w.type === 'control' && (
          <>
            <Row gutter={12}>
              <Col span={10}>
                <Form.Item label="Control type">
                  <Radio.Group
                    optionType="button"
                    value={w.control?.kind ?? 'dropdown'}
                    onChange={(e) => setW({ ...w, control: { ...w.control, kind: e.target.value } })}
                    options={[
                      { value: 'dropdown', label: 'Dropdown' },
                      { value: 'slider', label: 'Slider' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={14}>
                <Form.Item
                  label="Parameter name"
                  validateStatus={paramIdBad ? 'error' : paramIdDup ? 'warning' : undefined}
                  help={
                    paramIdBad
                      ? '영문/숫자/밑줄만 쓰고 글자로 시작하세요 (공백·$ 사용 불가)'
                      : paramIdDup
                        ? `다른 컨트롤 위젯이 이미 '${paramId}' 를 쓰고 있어요 — 둘이 같은 값을 공유하게 돼요. 다른 이름을 쓰세요`
                        : undefined
                  }
                  extra={!paramIdBad && !paramIdDup ? '다른 위젯에서 이 이름(⚙)으로 골라 이 컨트롤에 연결합니다. 예: metric' : undefined}
                >
                  <Input value={w.control?.paramId ?? ''} placeholder="metric" onChange={(e) => setW({ ...w, control: { ...w.control, paramId: e.target.value.trim() } })} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              label={w.control?.kind === 'slider' ? 'Steps, in order (0, 1, 2 …)' : 'Options'}
              extra="고를 이름과, 고르면 차트 등에 실제로 쓰일 컬럼명. 예) F14 Area → F14 Area"
            >
              {ctrlOptions.map((o, i) => (
                <Row key={i} gutter={8} align="middle" style={{ marginBottom: 6 }}>
                  <Col span={9}>
                    <Input placeholder="Label (e.g. F14 Area)" value={o.label} onChange={(e) => setControlOptions(ctrlOptions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  </Col>
                  <Col span={12}>
                    <AutoComplete
                      style={{ width: '100%' }}
                      placeholder="Column name"
                      options={colSuggest}
                      filterOption={(q, o) => (o?.value ?? '').toLowerCase().includes(q.toLowerCase())}
                      value={o.value}
                      onChange={(v) => setControlOptions(ctrlOptions.map((x, j) => (j === i ? { ...x, value: v } : x)))}
                    />
                  </Col>
                  <Col span={3}>
                    <Button type="text" icon={<MinusCircleOutlined />} onClick={() => setControlOptions(ctrlOptions.filter((_, j) => j !== i))} />
                  </Col>
                </Row>
              ))}
              <Button size="small" icon={<PlusOutlined />} onClick={() => setControlOptions([...ctrlOptions, { label: '', value: '' }])}>
                Add option
              </Button>
            </Form.Item>
          </>
        )}
        {w.type !== 'text' && w.type !== 'control' && (
          <>
            <Divider style={{ margin: '4px 0 14px' }} />
            <Form.Item label="React to selection in other widgets" extra="테이블에서 행을 클릭해 선택한 값(예: VAID)을 이 위젯에 어떻게 반영할지">
              <Radio.Group
                value={w.link?.mode ?? 'auto'}
                onChange={(e) => setW({ ...w, link: { ...w.link, mode: e.target.value } })}
                options={[
                  { value: 'auto', label: 'Auto (same column name)' },
                  { value: 'column', label: 'Pick column' },
                  { value: 'off', label: 'Ignore' },
                ]}
              />
            </Form.Item>
            {w.link?.mode === 'column' && (
              <Form.Item label="Column to compare with selection">
                <Select showSearch value={w.link.column} options={rawCols} onChange={(v) => setW({ ...w, link: { ...w.link, column: v } })} />
              </Form.Item>
            )}
            {(w.link?.mode ?? 'auto') === 'auto' && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message="선택 컬럼과 이름이 같거나, 접두어를 뗀 이름이 같은 컬럼을 찾습니다 (예: VAID ↔ drive.VAID, 여러 개면 첫 번째). 못 찾으면 반응하지 않습니다."
              />
            )}
            {canHighlight(w) && (w.link?.mode ?? 'auto') !== 'off' && (
              <Form.Item label="Behavior">
                <Radio.Group
                  value={w.link?.behavior ?? 'highlight'}
                  optionType="button"
                  onChange={(e) => setW({ ...w, link: { ...w.link, behavior: e.target.value } })}
                  options={[
                    { value: 'highlight', label: 'Highlight among all' },
                    { value: 'filter', label: 'Show selected only' },
                  ]}
                />
              </Form.Item>
            )}
          </>
        )}
      </Form>
    </Modal>
  );
}

/** 차트 배경 이미지: 이미지 선택, 투명도, 시작 좌표·크기 (차트 영역 % 또는 축 값) */
function BackgroundForm({ kind, value: bg, onChange }: { kind: ChartKind; value?: ChartBackground; onChange: (v: ChartBackground | undefined) => void }) {
  const [err, setErr] = useState('');
  const axisOk = AXIS_BG_KINDS.includes(kind);
  const unit: BgUnit = bg ? bgUnit(bg, kind) : 'percent';
  const pct = unit === 'percent';
  const set = (p: Partial<ChartBackground>) => bg && onChange({ ...bg, ...p });
  const pick = (file: File) => {
    setErr('');
    readImageFile(file)
      // 이미지만 바꾸면 위치·투명도 설정은 그대로 둠
      .then((img) => onChange({ ...BG_DEFAULTS, ...bg, ...img }))
      .catch((e) => setErr(e.message));
    return false;
  };
  // % 와 축 값은 단위가 달라 좌표를 그대로 옮길 수 없음 → 방식을 바꾸면 좌표를 초기화
  const setUnit = (u: BgUnit) => set(u === 'percent' ? { unit: u, x: 0, y: 0, w: 100, h: 100 } : { unit: u, x: null, y: null, w: null, h: null });
  const chooser = (label: string, icon = <PictureOutlined />) => (
    <Upload accept="image/*" showUploadList={false} beforeUpload={pick}>
      <Button size="small" icon={icon}>
        {label}
      </Button>
    </Upload>
  );

  return (
    <Form.Item
      label="Background image"
      extra={!bg ? '도면·지그·트레이 사진 등을 차트 뒤에 깔아 측정 위치와 겹쳐 볼 수 있어요. 큰 이미지는 긴 변 2000px 로 줄여 대시보드에 함께 저장됩니다.' : undefined}
      validateStatus={err ? 'error' : undefined}
      help={err || undefined}
    >
      {!bg ? (
        chooser('Choose image')
      ) : (
        <div className="layer-box" style={{ marginBottom: 0, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <div className="bg-thumb">
              <img src={bg.src} alt="" style={{ opacity: bg.opacity ?? BG_DEFAULTS.opacity }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600 }}>
                {bg.name || 'Image'}
              </div>
              <div className="muted num" style={{ fontSize: 12 }}>
                {bg.iw && bg.ih ? `${bg.iw} × ${bg.ih}px · ` : ''}
                {Math.max(1, Math.round(dataUrlBytes(bg.src) / 1024)).toLocaleString()} KB
              </div>
            </div>
            {chooser('Replace')}
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => onChange(undefined)} />
          </div>

          <Row gutter={12} align="middle">
            <Col flex="72px" style={{ fontSize: 13 }}>
              Opacity
            </Col>
            <Col flex="auto">
              <Slider min={0} max={100} value={Math.round((bg.opacity ?? BG_DEFAULTS.opacity) * 100)} onChange={(v) => set({ opacity: v / 100 })} tooltip={{ formatter: (v) => `${v}%` }} />
            </Col>
            <Col flex="96px">
              <InputNumber size="small" min={0} max={100} addonAfter="%" value={Math.round((bg.opacity ?? BG_DEFAULTS.opacity) * 100)} onChange={(v) => set({ opacity: (v ?? 0) / 100 })} style={{ width: 96 }} />
            </Col>
          </Row>

          <Row gutter={12} align="middle" style={{ margin: '10px 0' }}>
            <Col flex="72px" style={{ fontSize: 13 }}>
              Position
            </Col>
            <Col flex="auto">
              <Radio.Group
                size="small"
                optionType="button"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                options={[
                  { value: 'percent', label: 'Chart area (%)' },
                  {
                    value: 'axis',
                    disabled: !axisOk,
                    label: axisOk ? (
                      'Axis values'
                    ) : (
                      <Tooltip title="Scatter, XY position 차트처럼 X·Y 가 모두 숫자 축일 때만 쓸 수 있어요">
                        <span>Axis values</span>
                      </Tooltip>
                    ),
                  },
                ]}
              />
            </Col>
          </Row>

          <Space wrap size={8}>
            <InputNumber size="small" addonBefore={pct ? 'Left' : 'X start'} addonAfter={pct ? '%' : undefined} step={pct ? 1 : 0.001} value={bg.x} onChange={(v) => set({ x: v })} style={{ width: pct ? 140 : 160 }} />
            <InputNumber size="small" addonBefore={pct ? 'Top' : 'Y start'} addonAfter={pct ? '%' : undefined} step={pct ? 1 : 0.001} value={bg.y} onChange={(v) => set({ y: v })} style={{ width: pct ? 140 : 160 }} />
            <InputNumber size="small" addonBefore="Width" addonAfter={pct ? '%' : undefined} min={0} step={pct ? 1 : 0.001} value={bg.w} onChange={(v) => set({ w: v })} style={{ width: pct ? 150 : 160 }} />
            <InputNumber
              size="small"
              addonBefore="Height"
              addonAfter={pct ? '%' : undefined}
              min={0}
              step={pct ? 1 : 0.001}
              disabled={!!bg.keepAspect}
              placeholder={bg.keepAspect ? 'auto' : undefined}
              value={bg.keepAspect ? null : bg.h}
              onChange={(v) => set({ h: v })}
              style={{ width: pct ? 150 : 160 }}
            />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <Switch size="small" checked={!!bg.keepAspect} onChange={(v) => set({ keepAspect: v })} />
              Keep aspect ratio
            </span>
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
            {pct
              ? '차트 영역의 왼쪽 위가 (0, 0), 오른쪽 아래가 (100, 100) 입니다. 예) Left 10 · Top 5 · Width 80 → 가로 80% 크기로 가운데쯤에 배치'
              : '이미지 왼쪽 아래 모서리를 축 값 (X start, Y start) 에 두고, 가로·세로를 축 단위로 정합니다. 데이터와 같은 좌표계라 실제 위치에 맞춰 겹쳐 볼 수 있어요.'}
          </Typography.Paragraph>
          {!pct && (bg.x == null || bg.y == null || !bg.w || (!bg.keepAspect && !bg.h)) && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              X start, Y start, Width{bg.keepAspect ? '' : ', Height'} 를 모두 넣으면 표시됩니다.
            </Typography.Text>
          )}
        </div>
      )}
    </Form.Item>
  );
}
