import { Alert, Button, Col, Divider, Form, Input, InputNumber, Modal, Radio, Row, Select, Space, Switch, Typography } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useState } from 'react';
import type { Dataset } from '../api';
import { ChartKind, neededColumns } from './charts';
import type { Layer } from './link';
import { canHighlight, Widget } from './Widget';

const KINDS: { value: ChartKind; label: string }[] = [
  { value: 'line', label: '선 (추이)' },
  { value: 'area', label: '영역' },
  { value: 'bar', label: '막대' },
  { value: 'scatter', label: '산점도 (두 값의 상관)' },
  { value: 'xy', label: '좌표 분포 (X·Y 위치)' },
  { value: 'histogram', label: '히스토그램 (분포)' },
  { value: 'box', label: '박스플롯' },
  { value: 'heatmap', label: '히트맵 (행렬)' },
  { value: 'pie', label: '도넛 (구성비)' },
];

export default function WidgetEditor({ value, datasets, onOk, onCancel }: { value: Widget; datasets: Dataset[]; onOk: (w: Widget) => void; onCancel: () => void }) {
  const [w, setW] = useState<Widget>(value);
  const ds = datasets.find((d) => d.name === w.dataset);
  const colsOf = (name?: string) => (datasets.find((d) => d.name === name)?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name}  ·  ${c.dtype}` }));
  const cols = colsOf(w.dataset);
  const numCols = (ds?.columns ?? []).filter((c) => c.dtype === 'number').map((c) => ({ value: c.name, label: c.name }));
  const chart = w.chart ?? { kind: 'line' as ChartKind, y: [] };
  const setChart = (p: Partial<typeof chart>) => setW({ ...w, chart: { ...chart, ...p } });
  const spec = chart.spec ?? {};
  const setSpec = (p: Partial<typeof spec>) => setChart({ spec: { ...spec, ...p } });
  const kind = chart.kind;
  const layers = w.layers ?? [];
  const setLayer = (i: number, p: Partial<Layer>) => setW({ ...w, layers: layers.map((l, j) => (j === i ? { ...l, ...p } : l)) });

  // 겹친 데이터셋에서 대응시켜야 하는 컬럼 (위젯이 쓰는 컬럼 + 선택/연동 컬럼)
  const used = [...new Set([...neededColumns(w), w.type === 'table' ? w.select?.column : undefined, w.link?.mode === 'column' ? w.link.column : undefined].filter(Boolean) as string[])];
  const isXY = w.type === 'chart' && kind === 'xy';

  return (
    <Modal open width={760} title="위젯 설정" onOk={() => onOk(w)} onCancel={onCancel} okText="적용" destroyOnClose styles={{ body: { maxHeight: '72vh', overflowY: 'auto', paddingRight: 8 } }}>
      <Form layout="vertical" size="middle">
        <Row gutter={12}>
          <Col span={14}>
            <Form.Item label="제목">
              <Input value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} />
            </Form.Item>
          </Col>
          <Col span={10}>
            <Form.Item label="종류">
              <Radio.Group
                value={w.type}
                optionType="button"
                onChange={(e) => setW({ ...w, type: e.target.value })}
                options={[
                  { value: 'chart', label: '차트' },
                  { value: 'table', label: '테이블' },
                  { value: 'stat', label: '수치' },
                  { value: 'text', label: '텍스트' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        {w.type !== 'text' && (
          <>
            <Row gutter={12}>
              <Col span={layers.length ? 15 : 24}>
                <Form.Item label="데이터셋">
                  <Select
                    showSearch
                    value={w.dataset}
                    onChange={(v) => setW({ ...w, dataset: v })}
                    options={datasets.map((d) => ({ value: d.name, label: `${d.name}  (${d.row_count.toLocaleString()}행)` }))}
                  />
                </Form.Item>
              </Col>
              {layers.length > 0 && (
                <Col span={9}>
                  <Form.Item label="표시 이름">
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
                      <Form.Item label={`겹칠 데이터셋 ${i + 2}`} style={{ marginBottom: 8 }}>
                        <Select
                          showSearch
                          value={l.dataset}
                          onChange={(v) => setLayer(i, { dataset: v, map: {} })}
                          options={datasets.map((d) => ({ value: d.name, label: `${d.name}  (${d.row_count.toLocaleString()}행)` }))}
                        />
                      </Form.Item>
                    </Col>
                    <Col span={7}>
                      <Form.Item label="표시 이름" style={{ marginBottom: 8 }}>
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
                        컬럼 대응 — 이름이 같으면 자동, 다르면 이 데이터셋의 컬럼을 고르세요
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
                                placeholder="없음 — 이 데이터셋에선 빈 값"
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
              데이터셋 겹치기
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
            <Form.Item label="차트">
              <Select value={kind} options={KINDS} onChange={(v) => setChart({ kind: v, ...(v === 'xy' ? { y: (chart.y ?? []).slice(0, 1) } : {}) })} />
            </Form.Item>
            {isXY ? (
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="X 좌표">
                    <Select allowClear showSearch value={chart.x} options={numCols} onChange={(v) => setChart({ x: v })} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="Y 좌표">
                    <Select allowClear showSearch value={chart.y?.[0]} options={numCols} onChange={(v) => setChart({ y: v ? [v] : [] })} />
                  </Form.Item>
                </Col>
              </Row>
            ) : (
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label={kind === 'heatmap' ? '행 라벨 컬럼' : kind === 'box' ? '그룹 (X, 선택)' : kind === 'pie' ? '구분 컬럼' : kind === 'histogram' ? '값 컬럼' : 'X 축'}>
                    <Select allowClear showSearch value={chart.x} options={cols} onChange={(v) => setChart({ x: v })} />
                  </Form.Item>
                </Col>
                {kind !== 'histogram' && (
                  <Col span={12}>
                    <Form.Item label={kind === 'heatmap' ? '값 컬럼 (비우면 숫자 전체)' : kind === 'pie' ? '값 (비우면 개수)' : 'Y 값'}>
                      <Select mode="multiple" value={chart.y ?? []} options={numCols} maxCount={kind === 'pie' ? 1 : undefined} onChange={(v) => setChart({ y: v })} />
                    </Form.Item>
                  </Col>
                )}
              </Row>
            )}
            <Row gutter={12}>
              {['line', 'area', 'bar', 'scatter', 'xy', 'histogram'].includes(kind) && (
                <Col span={12}>
                  <Form.Item label="시리즈 구분 (색상)" extra={isXY ? '예: 설비별로 색 구분' : 'Y 가 1개일 때 이 컬럼 값별로 나눠 표시'}>
                    <Select allowClear showSearch value={chart.series} options={cols} onChange={(v) => setChart({ series: v })} />
                  </Form.Item>
                </Col>
              )}
              {(kind === 'scatter' || isXY) && (
                <Col span={12}>
                  <Form.Item label="툴팁에 표시할 컬럼" extra="점에 마우스를 올리면 함께 보여줌 (예: VAID)">
                    <Select allowClear showSearch value={chart.tip} options={cols} onChange={(v) => setChart({ tip: v })} />
                  </Form.Item>
                </Col>
              )}
              {['line', 'area', 'bar', 'pie'].includes(kind) && (
                <Col span={6}>
                  <Form.Item label="집계">
                    <Select
                      value={chart.agg ?? 'none'}
                      onChange={(v) => setChart({ agg: v })}
                      options={['none', 'mean', 'sum', 'count', 'min', 'max'].map((a) => ({ value: a, label: a === 'none' ? '원본' : a }))}
                    />
                  </Form.Item>
                </Col>
              )}
              {kind === 'bar' && (
                <Col span={6}>
                  <Form.Item label="정렬">
                    <Select value={chart.sort ?? 'none'} onChange={(v) => setChart({ sort: v })} options={[{ value: 'none', label: '없음' }, { value: 'desc', label: '큰 값부터' }, { value: 'asc', label: '작은 값부터' }]} />
                  </Form.Item>
                </Col>
              )}
              {['line', 'area', 'bar'].includes(kind) && (
                <Col span={6}>
                  <Form.Item label="누적">
                    <Switch checked={!!chart.stack} onChange={(v) => setChart({ stack: v })} />
                  </Form.Item>
                </Col>
              )}
              {kind === 'scatter' && (
                <Col span={6}>
                  <Form.Item label="추세선">
                    <Switch checked={!!chart.trendline} onChange={(v) => setChart({ trendline: v })} />
                  </Form.Item>
                </Col>
              )}
              {kind === 'histogram' && (
                <Col span={6}>
                  <Form.Item label="구간 수">
                    <InputNumber min={2} max={200} value={chart.bins ?? 20} onChange={(v) => setChart({ bins: v ?? 20 })} />
                  </Form.Item>
                </Col>
              )}
            </Row>
            {isXY && (
              <>
                <Row gutter={12}>
                  <Col span={8}>
                    <Form.Item label="축 눈금 1:1" extra="실제 위치 모양 그대로">
                      <Switch checked={chart.equal ?? true} onChange={(v) => setChart({ equal: v })} />
                    </Form.Item>
                  </Col>
                  <Col span={8}>
                    <Form.Item label="평균 중심 (+) 표시">
                      <Switch checked={chart.centroid ?? true} onChange={(v) => setChart({ centroid: v })} />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item label="기준 위치 · 허용 범위" extra="범위를 벗어난 점은 ▲ 로 표시하고 개수를 보여줍니다">
                  <Radio.Group
                    value={spec.shape ?? 'none'}
                    optionType="button"
                    onChange={(e) => setSpec({ shape: e.target.value })}
                    options={[
                      { value: 'none', label: '없음' },
                      { value: 'circle', label: '원 (반지름)' },
                      { value: 'rect', label: '사각 (±X, ±Y)' },
                    ]}
                  />
                </Form.Item>
                {(spec.shape ?? 'none') !== 'none' && (
                  <Space wrap style={{ marginBottom: 16 }}>
                    <InputNumber addonBefore="중심 X" step={0.001} value={spec.cx} onChange={(v) => setSpec({ cx: v })} style={{ width: 170 }} />
                    <InputNumber addonBefore="중심 Y" step={0.001} value={spec.cy} onChange={(v) => setSpec({ cy: v })} style={{ width: 170 }} />
                    {spec.shape === 'circle' ? (
                      <InputNumber addonBefore="반지름" min={0} step={0.001} value={spec.r} onChange={(v) => setSpec({ r: v })} style={{ width: 170 }} />
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
          </>
        )}
        {w.type === 'table' && (
          <>
            <Row gutter={12}>
              <Col span={18}>
                <Form.Item label="표시 컬럼 (비우면 전체)">
                  <Select mode="multiple" value={w.table?.columns ?? []} options={cols} onChange={(v) => setW({ ...w, table: { ...w.table, columns: v } })} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="페이지 행 수">
                  <InputNumber min={5} max={500} value={w.table?.pageSize ?? 20} onChange={(v) => setW({ ...w, table: { ...w.table, pageSize: v ?? 20 } })} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="행 클릭 시 선택할 값" extra="행을 클릭하면 이 컬럼 값으로 다른 위젯이 바뀝니다 (예: VAID). 비우면 클릭 선택 안 함">
              <Select allowClear showSearch placeholder="선택 안 함" value={w.select?.column} options={cols} onChange={(v) => setW({ ...w, select: v ? { column: v } : undefined })} />
            </Form.Item>
          </>
        )}
        {w.type === 'stat' && (
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item label="컬럼">
                <Select allowClear showSearch value={w.stat?.column} options={cols} onChange={(v) => setW({ ...w, stat: { ...w.stat, column: v } })} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="계산">
                <Select
                  value={w.stat?.agg ?? 'count'}
                  onChange={(v) => setW({ ...w, stat: { ...w.stat, agg: v } })}
                  options={[
                    { value: 'count', label: '개수' },
                    { value: 'distinct', label: '고유 개수' },
                    { value: 'mean', label: '평균' },
                    { value: 'sum', label: '합계' },
                    { value: 'min', label: '최소' },
                    { value: 'max', label: '최대' },
                    { value: 'last', label: '마지막 값' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="소수점">
                <InputNumber min={0} max={6} value={w.stat?.decimals ?? 0} onChange={(v) => setW({ ...w, stat: { ...w.stat, decimals: v ?? 0 } })} />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item label="단위">
                <Input value={w.stat?.suffix} onChange={(e) => setW({ ...w, stat: { ...w.stat, suffix: e.target.value } })} />
              </Form.Item>
            </Col>
          </Row>
        )}
        {w.type === 'text' && (
          <Form.Item label="내용">
            <Input.TextArea autoSize={{ minRows: 4 }} value={w.text?.content} onChange={(e) => setW({ ...w, text: { content: e.target.value } })} />
          </Form.Item>
        )}
        {w.type !== 'text' && (
          <>
            <Divider style={{ margin: '4px 0 14px' }} />
            <Form.Item label="다른 위젯의 선택에 반응" extra="테이블에서 행을 클릭해 선택한 값(예: VAID)을 이 위젯에 어떻게 반영할지">
              <Radio.Group
                value={w.link?.mode ?? 'auto'}
                onChange={(e) => setW({ ...w, link: { ...w.link, mode: e.target.value } })}
                options={[
                  { value: 'auto', label: '자동 (같은 이름의 컬럼)' },
                  { value: 'column', label: '컬럼 지정' },
                  { value: 'off', label: '반응 안 함' },
                ]}
              />
            </Form.Item>
            {w.link?.mode === 'column' && (
              <Form.Item label="선택 값과 비교할 컬럼">
                <Select showSearch value={w.link.column} options={cols} onChange={(v) => setW({ ...w, link: { ...w.link, column: v } })} />
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
              <Form.Item label="반영 방식">
                <Radio.Group
                  value={w.link?.behavior ?? 'highlight'}
                  optionType="button"
                  onChange={(e) => setW({ ...w, link: { ...w.link, behavior: e.target.value } })}
                  options={[
                    { value: 'highlight', label: '전체 중 강조' },
                    { value: 'filter', label: '선택한 것만 표시' },
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
