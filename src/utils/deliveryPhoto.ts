import { supabase } from '../services/supabase';

/**
 * Uploads a delivery proof photo to storage and links it to the order in the database.
 */
export async function uploadDeliveryPhoto(
  orderId: string,
  uri: string,
): Promise<string | null> {
  try {
    const timestamp = Date.now();
    const fileExt = uri.split('.').pop() ?? 'jpg';
    const filePath = `${orderId}/${timestamp}.${fileExt}`;

    // Read the image file
    const response = await fetch(uri);
    const blob = await response.blob();

    // Convert blob to ArrayBuffer for upload
    const arrayBuffer = await new Response(blob).arrayBuffer();

    // Ensure the delivery proofs row exists in DB before uploading photo
    // Perform an upsert which handles both new records and existing ones
    const { error: dbError } = await supabase
      .from('delivery_proofs')
      .upsert(
        { order_id: orderId, updated_at: new Date().toISOString() },
        { onConflict: 'order_id' }
      );

    if (dbError) {
      console.warn('[Photo Upload] Warning ensuring delivery_proofs row exists:', dbError.message);
      // Fallback: If upsert failed (e.g. because of nullable constraints before migration run),
      // we can try the RPC generate_delivery_otp
      const { error: rpcError } = await supabase.rpc('generate_delivery_otp', {
        p_order_id: orderId,
      });
      if (rpcError) {
        console.error('[Photo Upload] RPC fallback failed too:', rpcError.message);
      }
    }

    const { error: uploadError } = await supabase.storage
      .from('delivery-photos')
      .upload(filePath, arrayBuffer, {
        contentType: `image/${fileExt}`,
        upsert: false,
      });

    if (uploadError) {
      console.error('[Photo Upload] Storage upload error:', uploadError);
      return null;
    }

    // Get the public URL
    const { data: urlData } = supabase.storage
      .from('delivery-photos')
      .getPublicUrl(filePath);

    const photoUrl = urlData?.publicUrl ?? null;

    // Save photo URL to delivery_proofs
    if (photoUrl) {
      const { error: updateError } = await supabase
        .from('delivery_proofs')
        .update({
          photo_url: photoUrl,
          photo_uploaded_at: new Date().toISOString(),
        })
        .eq('order_id', orderId);

      if (updateError) {
        console.error('[Photo Upload] Database update error:', updateError.message);
      }
    }

    return photoUrl;
  } catch (err) {
    console.error('[Photo Upload] Failed:', err);
    return null;
  }
}
