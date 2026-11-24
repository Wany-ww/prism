import { Col, Form, Input, InputNumber, Modal, Radio, Row, Select, Switch } from 'antd';
import { useState } from 'react';
import type { Dataset } from '../api';
import type { ChartKind } from './charts';
import type { Widget } from './Widget';

const KINDS: { value: ChartKind; label: string }[] = [
  { value: 'line', label: '선 (추이)' },
  { value: 'area', label: '영역' },
  { value: 'bar', label: '막대' },
  { value: 'scatter', label: '산점도 (상관)' },
  { value: 'histogram', label: '히스토그램 (분포)' },
  { value: 'box', label: '박스플롯' },
  { value: 'heatmap', label: '히트맵 (행렬)' },
  { value: 'pie', label: '도넛 (구성비)' },
];

export default function WidgetEditor({ value, datasets, onOk, onCancel }: { value: Widget; datasets: Dataset[]; onOk: (w: Widget) => void; onCancel: () => void }) {
  const [w, setW] = useState<Widget>(value);
  const ds = datasets.find((d) => d.name === w.dataset);
  const cols = (ds?.columns ?? []).map((c) => ({ value: c.name, label: `${c.name}  ·  ${c.dtype}` }));
  const numCols = (ds?.columns ?? []).filter((c) => c.dtype === 'number').map((c) => ({ value: c.name, label: c.name }));
  const chart = w.chart ?? { kind: 'line' as ChartKind, y: [] };
  const setChart = (p: Partial<typeof chart>) => setW({ ...w, chart: { ...chart, ...p } });
  const kind = chart.kind;

  return (
    <Modal open width={680} title="위젯 설정" onOk={() => onOk(w)} onCancel={onCancel} okText="적용" destroyOnClose>
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
          <Form.Item label="데이터셋">
            <Select
              showSearch
              value={w.dataset}
              onChange={(v) => setW({ ...w, dataset: v })}
              options={datasets.map((d) => ({ value: d.name, label: `${d.name}  (${d.row_count.toLocaleString()}행)` }))}
            />
          </Form.Item>
        )}
        {w.type === 'chart' && (
          <>
            <Form.Item label="차트">
              <Select value={kind} options={KINDS} onChange={(v) => setChart({ kind: v })} />
            </Form.Item>
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
            <Row gutter={12}>
              {['line', 'area', 'bar', 'scatter', 'histogram'].includes(kind) && (
                <Col span={12}>
                  <Form.Item label="시리즈 구분 (색상)" extra="Y 가 1개일 때 이 컬럼 값별로 나눠 표시">
                    <Select allowClear showSearch value={chart.series} options={cols} onChange={(v) => setChart({ series: v })} />
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
          </>
        )}
        {w.type === 'table' && (
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
      </Form>
    </Modal>
  );
}
