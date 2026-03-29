import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/* ✅ LOCAL TYPE — matches existing usage */
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

export const CategoryCard: React.FC<CategoryCardProps> = React.memo(({ category, onPress }) => {
  const iconName = categoryIcons[category.name] || 'cube';

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.iconContainer}>
        {category.image ? (
          <Image source={{ uri: category.image }} style={styles.image} />
        ) : (
          <Ionicons name={iconName} size={28} color="#4C51C9" />
        )}
      </View>
      <Text style={styles.name} numberOfLines={2}>
        {category.name}
      </Text>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    width: 80,
    marginRight: 16,
  },
  iconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#ECEDFB',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  image: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  name: {
    fontSize: 12,
    fontWeight: '500',
    color: '#333',
    textAlign: 'center',
  },
});
