const fs = require('fs');

const files = [
  'app/admin/orders.tsx',
  'app/admin/stock.tsx',
  'app/admin/products/index.tsx',
  'app/admin/retailers/index.tsx',
  'app/admin/orders/[id].tsx',
  'app/admin/products/[id].tsx',
  'app/admin/retailers/[id].tsx',
];

const colorMap = [
  [/backgroundColor: '#f5f5f5'/g, 'backgroundColor: c.background'],
  [/backgroundColor: '#fff'/g, 'backgroundColor: c.surface'],
  [/backgroundColor: '#ffffff'/g, 'backgroundColor: c.surface'],
  [/color: '#333'/g, 'color: c.text'],
  [/color: '#666'/g, 'color: c.textSecondary'],
  [/color: '#555'/g, 'color: c.textSecondary'],
  [/color: '#888'/g, 'color: c.textMuted'],
  [/color: '#999'/g, 'color: c.textMuted'],
  [/color: '#aaa'/g, 'color: c.textMuted'],
  [/color: '#bbb'/g, 'color: c.textMuted'],
  [/borderColor: '#e0e0e0'/g, 'borderColor: c.border'],
  [/borderColor: '#eee'/g, 'borderColor: c.border'],
  [/borderColor: '#ddd'/g, 'borderColor: c.border'],
  [/borderColor: '#e8e8e8'/g, 'borderColor: c.border'],
  [/borderBottomColor: '#f0f0f0'/g, 'borderBottomColor: c.borderLight'],
  [/borderTopColor: '#f0f0f0'/g, 'borderTopColor: c.borderLight'],
  [/borderBottomColor: '#f8f8f8'/g, 'borderBottomColor: c.border'],
  [/backgroundColor: '#4C51C9'/g, 'backgroundColor: c.primary'],
  [/borderColor: '#4C51C9'/g, 'borderColor: c.primary'],
  [/color: '#4C51C9'/g, 'color: c.primary'],
  [/backgroundColor: '#ECEDFB'/g, 'backgroundColor: c.primaryMuted'],
  [/backgroundColor: '#E8F5E9'/g, 'backgroundColor: c.successMuted'],
  [/color: '#43A047'/g, 'color: c.success'],
  [/borderColor: '#43A047'/g, 'borderColor: c.success'],
  [/backgroundColor: '#43A047'/g, 'backgroundColor: c.success'],
  [/color: '#EF5350'/g, 'color: c.error'],
  [/backgroundColor: '#EF5350'/g, 'backgroundColor: c.error'],
  [/borderColor: '#e53935'/g, 'borderColor: c.error'],
  [/color: '#C62828'/g, 'color: c.error'],
  [/backgroundColor: '#FFF3E0'/g, 'backgroundColor: c.warningBg'],
  [/backgroundColor: '#fafafa'/g, 'backgroundColor: c.surfaceSecondary'],
  [/backgroundColor: '#f0f0f0'/g, 'backgroundColor: c.borderLight'],
  [/color: '#fff'/g, 'color: c.onPrimary'],
  [/backgroundColor: '#2E7D32'/g, 'backgroundColor: c.success'],
  [/borderColor: '#2E7D32'/g, 'borderColor: c.success'],
];

function importPrefix(rel) {
  if (rel.includes('products/') || rel.includes('retailers/') || rel.includes('orders/')) {
    return '../../../src';
  }
  return '../../src';
}

function convertFile(rel) {
  let content = fs.readFileSync(rel, 'utf8');
  if (content.includes('useThemedStyles(createStyles)')) {
    console.log('skip already', rel);
    return;
  }
  const prefix = importPrefix(rel);

  content = content.replace(/  StyleSheet,\n/g, '');
  if (!content.includes('useAppTheme')) {
    const marker = `from '${prefix}/services/supabase'`;
    const idx = content.indexOf(marker);
    if (idx > -1) {
      const lineEnd = content.indexOf('\n', idx) + 1;
      const themeImports =
        `import { useAppTheme } from '${prefix}/hooks/useAppTheme';\n` +
        `import { useThemedStyles } from '${prefix}/theme/useThemedStyles';\n` +
        `import type { AppColors } from '${prefix}/theme/colors';\n`;
      content = content.slice(0, lineEnd) + themeImports + content.slice(lineEnd);
    }
  }

  content = content.replace(/export default function (\w+)\(\) \{\n/, (m, name) => {
    return `export default function ${name}() {\n  const styles = useThemedStyles(createStyles);\n  const { colors } = useAppTheme();\n`;
  });

  const start = content.indexOf('const styles = StyleSheet.create({');
  const end = content.lastIndexOf('});');
  if (start === -1 || end <= start) {
    console.log('no styles', rel);
    return;
  }
  let stylesBody = content.slice(start + 'const styles = StyleSheet.create({'.length, end);
  for (const [re, rep] of colorMap) stylesBody = stylesBody.replace(re, rep);
  stylesBody = stylesBody.replace(
    /StyleSheet\.absoluteFillObject/g,
    "{ position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 }",
  );
  const asConstProps = [
    'flexDirection',
    'justifyContent',
    'alignItems',
    'fontWeight',
    'textAlign',
    'position',
    'textTransform',
    'overflow',
    'flexWrap',
    'fontStyle',
    'alignSelf',
  ];
  for (const prop of asConstProps) {
    const re = new RegExp(`${prop}: '([^']+)'`, 'g');
    stylesBody = stylesBody.replace(re, `${prop}: '$1' as const`);
  }
  stylesBody = stylesBody.replace(/marginLeft: 'auto'/g, "marginLeft: 'auto' as const");
  stylesBody = stylesBody.replace(/height: '100%'/g, "height: '100%' as const");
  stylesBody = stylesBody.replace(/width: '(\d+%)'/g, "width: '$1' as const");

  const newStyles = `function createStyles(c: AppColors, _isDark: boolean) {\n  return {${stylesBody}\n  };\n}\n`;
  content = content.slice(0, start) + newStyles + content.slice(end + 3);

  content = content.replace(
    /<SafeAreaView style=\{styles\.container\}>/g,
    "<SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>",
  );
  content = content.replace(
    /edges=\{\['bottom'\]\}/g,
    "edges={['top', 'left', 'right', 'bottom']}",
  );

  const jsxReplacements = [
    [/color="#4C51C9"/g, 'color={colors.primary}'],
    [/color="#999"/g, 'color={colors.textMuted}'],
    [/color="#888"/g, 'color={colors.textMuted}'],
    [/color="#ccc"/g, 'color={colors.textMuted}'],
    [/color="#666"/g, 'color={colors.textSecondary}'],
    [/color="#EF5350"/g, 'color={colors.error}'],
    [/color="#fff"/g, 'color={colors.onPrimary}'],
    [/color="#66BB6A"/g, 'color={colors.success}'],
    [/color="#5C6BC0"/g, 'color={colors.primary}'],
    [/color="#E65100"/g, 'color={colors.warning}'],
    [/color=\{isSelected \? '#4C51C9' : '#999'\}/g, 'color={isSelected ? colors.primary : colors.textMuted}'],
    [
      /color=\{dateRange === d\.key \? '#fff' : '#888'\}/g,
      'color={dateRange === d.key ? colors.onPrimary : colors.textMuted}',
    ],
    [
      /color=\{tab === t\.key \? '#fff' : '#666'\}/g,
      'color={tab === t.key ? colors.onPrimary : colors.textSecondary}',
    ],
    [/placeholderTextColor="#999"/g, 'placeholderTextColor={colors.textMuted}'],
    [/placeholderTextColor="#bbb"/g, 'placeholderTextColor={colors.textMuted}'],
    [/ActivityIndicator size="large" color="#4C51C9"/g, 'ActivityIndicator size="large" color={colors.primary}'],
    [/ActivityIndicator size="small" color="#4C51C9"/g, 'ActivityIndicator size="small" color={colors.primary}'],
    [/ActivityIndicator size="small" color="#fff"/g, 'ActivityIndicator size="small" color={colors.onPrimary}'],
    [
      /<RefreshControl refreshing=\{refreshing\} onRefresh=\{onRefresh\} \/>/g,
      '<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />',
    ],
    [/statusColor\[next\] \|\| '#4C51C9'/g, 'statusColor[next] || colors.primary'],
    [/statusColor\[item\.status\] \|\| '#999'/g, 'statusColor[item.status] || colors.textMuted'],
    [/item\.stock_quantity <= 10 && \{ color: '#EF5350' \}/g, 'item.stock_quantity <= 10 && { color: colors.error }'],
    [/trackColor=\{\{ false: '#ddd', true: '#A5D6A7' \}\}/g, 'trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}'],
    [/thumbColor=\{item\.approved \? '#43A047' : '#ccc'\}/g, 'thumbColor={item.approved ? colors.switchThumbOn : colors.switchThumbOff}'],
    [/barColor = pct > 80 \? '#EF5350' : pct > 60 \? '#FFA726' : '#4C51C9'/g, 'barColor = pct > 80 ? colors.error : pct > 60 ? colors.warning : colors.primary'],
    [/backgroundColor: item\.approved \? '#E8F5E9' : '#FFF3E0'/g, 'backgroundColor: item.approved ? colors.successMuted : colors.warningBg'],
    [/color: item\.approved \? '#43A047' : '#FFA726'/g, 'color: item.approved ? colors.success : colors.warning'],
    [/backgroundColor: item\.is_active \? '#E8F5E9' : '#FFF3E0'/g, 'backgroundColor: item.is_active ? colors.successMuted : colors.warningBg'],
    [/color: item\.is_active \? '#43A047' : '#FFA726'/g, 'color: item.is_active ? colors.success : colors.warning'],
  ];
  for (const [re, rep] of jsxReplacements) content = content.replace(re, rep);

  fs.writeFileSync(rel, content);
  console.log('converted', rel);
}

files.forEach(convertFile);
