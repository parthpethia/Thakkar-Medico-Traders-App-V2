import React from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../hooks/useAppTheme';
import { useThemedStyles } from '../theme/useThemedStyles';
import type { AppColors } from '../theme/colors';

interface Category {
  id: string;
  name: string;
  image?: string | null;
}

interface CategoryCardProps {
  category: Category;
  onPress: () => void;
}

const categoryIcons: Record<string, keyof typeof Ionicons.glyphMap> = {
  Tablets: 'medical',
  Syrups: 'water',
  Injections: 'fitness',
  Ointments: 'bandage',
  Surgical: 'cut',
};

function createStyles(c: AppColors) {
  return {
    card: {
      alignItems: 'center' as const,
      width: 80,
      marginRight: 16,
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: c.primaryMuted,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginBottom: 8,
    },
    image: {
      width: 64,
      height: 64,
      borderRadius: 32,
    },
    name: {
      fontSize: 12,
      fontWeight: '500' as const,
      color: c.text,
      textAlign: 'center' as const,
    },
  };
}

export const CategoryCard: React.FC<CategoryCardProps> = React.memo(({ category, onPress }) => {
  const styles = useThemedStyles(createStyles);
  const { colors } = useAppTheme();
  const iconName = categoryIcons[category.name] || 'cube';

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.iconContainer}>
        {category.image ? (
          <Image source={{ uri: category.image }} style={styles.image} />
        ) : (
          <Ionicons name={iconName} size={28} color={colors.primary} />
        )}
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {category.name}
      </Text>
    </TouchableOpacity>
  );
});
