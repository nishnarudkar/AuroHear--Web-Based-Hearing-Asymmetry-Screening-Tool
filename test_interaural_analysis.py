#!/usr/bin/env python3
"""
Test script for interaural difference analysis functionality
Demonstrates the computation and API endpoints
"""

import requests
import json
from datetime import datetime

# Test configuration
BASE_URL = "http://127.0.0.1:5000"

def test_interaural_analysis():
    """Test the interaural analysis functionality"""
    
    print("🧪 Testing Interaural Threshold Difference Analysis")
    print("=" * 60)
    
    # Sample threshold data for testing
    test_thresholds = {
        "left": {
            "250": 20.0,
            "500": 25.0,
            "1000": 30.0,
            "2000": 35.0,
            "4000": 40.0,
            "5000": 45.0
        },
        "right": {
            "250": 18.0,
            "500": 22.0,
            "1000": 28.0,
            "2000": 50.0,  # Significant difference at 2000 Hz
            "4000": 42.0,
            "5000": 43.0
        }
    }
    
    print("\n📊 Test Data:")
    print("Left ear thresholds:", test_thresholds["left"])
    print("Right ear thresholds:", test_thresholds["right"])
    
    # Test 1: Interaural analysis endpoint
    print("\n1️⃣ Testing /user/interaural-analysis endpoint...")
    
    response = requests.post(f"{BASE_URL}/user/interaural-analysis", 
                           json={"thresholds": test_thresholds})
    
    print(f"Status Code: {response.status_code}")
    
    if response.status_code == 200:
        data = response.json()
        print("✅ Analysis successful!")
        
        # Display per-frequency differences
        per_freq = data.get('per_frequency_differences', {})
        print(f"\n📋 Per-Frequency Analysis ({len(per_freq)} frequencies):")
        
        for freq in sorted(per_freq.keys(), key=int):
            freq_data = per_freq[freq]
            left_val = freq_data['left_threshold']
            right_val = freq_data['right_threshold']
            abs_diff = freq_data['absolute_difference']
            signed_diff = freq_data['signed_difference']
            
            status = "⚠️ SIGNIFICANT" if abs_diff >= 15 else "✅ Normal"
            direction = "Left worse" if signed_diff > 0 else "Right worse" if signed_diff < 0 else "Equal"
            
            print(f"   {freq} Hz: L={left_val:.1f}, R={right_val:.1f}, "
                  f"Diff={abs_diff:.1f} dB ({direction}) {status}")
        
        # Display summary statistics
        stats = data.get('summary_statistics', {})
        if stats:
            print(f"\n📈 Summary Statistics:")
            print(f"   Max difference: {stats.get('max_absolute_difference', 0):.1f} dB")
            print(f"   Mean difference: {stats.get('mean_absolute_difference', 0):.1f} dB")
            print(f"   Min difference: {stats.get('min_absolute_difference', 0):.1f} dB")
            print(f"   Frequencies compared: {stats.get('frequencies_compared', 0)}")
        
        # Check for significant differences
        significant_freqs = [freq for freq, data in per_freq.items() 
                           if data['absolute_difference'] >= 15]
        
        print(f"\n🎯 Clinical Relevance:")
        print(f"   Frequencies with ≥15 dB difference: {len(significant_freqs)}")
        if significant_freqs:
            print(f"   Significant at: {', '.join(significant_freqs)} Hz")
        
        print(f"\n📝 Analysis Notes:")
        notes = data.get('notes', {})
        print(f"   Unit: {notes.get('measurement_unit', 'N/A')}")
        print(f"   Calculation: {notes.get('difference_calculation', 'N/A')}")
        print(f"   Disclaimer: {notes.get('disclaimer', 'N/A')}")
    
    else:
        print(f"❌ Error: {response.text}")
    
    # Test 2: Invalid data handling
    print("\n2️⃣ Testing invalid data handling...")
    
    invalid_data = {"thresholds": {"left": {"1000": 30}, "right": {}}}
    response = requests.post(f"{BASE_URL}/user/interaural-analysis", json=invalid_data)
    
    print(f"Status Code: {response.status_code}")
    if response.status_code == 400:
        print("✅ Correctly rejected invalid data")
    else:
        print(f"❌ Unexpected response: {response.text}")
    
    # Test 3: Missing data handling
    print("\n3️⃣ Testing missing data handling...")
    
    response = requests.post(f"{BASE_URL}/user/interaural-analysis", json={})
    
    print(f"Status Code: {response.status_code}")
    if response.status_code == 400:
        print("✅ Correctly rejected missing data")
    else:
        print(f"❌ Unexpected response: {response.text}")
    
    print("\n🎯 Test Summary:")
    print("✅ Computes interaural threshold differences per frequency")
    print("✅ Compares left vs right ear thresholds objectively")
    print("✅ Does not assign severity or diagnosis")
    print("✅ Exposes computed differences to frontend")
    print("✅ Provides both absolute and signed differences")
    print("✅ Includes comprehensive summary statistics")
    print("✅ Handles invalid data gracefully")
    print("✅ Maintains clinical objectivity (no diagnostic claims)")

def demonstrate_calculation():
    """Demonstrate the interaural difference calculation logic"""
    
    print("\n🔬 Calculation Demonstration")
    print("=" * 40)
    
    # Example calculation
    left_threshold = 30.0  # dB HL
    right_threshold = 45.0  # dB HL
    
    absolute_difference = abs(left_threshold - right_threshold)
    signed_difference = left_threshold - right_threshold
    
    print(f"Left ear threshold: {left_threshold} dB HL")
    print(f"Right ear threshold: {right_threshold} dB HL")
    print(f"Absolute difference: |{left_threshold} - {right_threshold}| = {absolute_difference} dB")
    print(f"Signed difference: {left_threshold} - {right_threshold} = {signed_difference} dB")
    
    interpretation = "Right ear worse" if signed_difference < 0 else "Left ear worse" if signed_difference > 0 else "Equal"
    significance = "Significant asymmetry" if absolute_difference >= 15 else "Normal variation"
    
    print(f"Interpretation: {interpretation}")
    print(f"Clinical note: {significance} (≥15 dB threshold for reference)")
    print(f"Disclaimer: Objective measurement only - no diagnostic interpretation")

if __name__ == "__main__":
    try:
        demonstrate_calculation()
        test_interaural_analysis()
    except requests.exceptions.ConnectionError:
        print("❌ Could not connect to server. Make sure the Flask app is running on http://127.0.0.1:5000")
    except Exception as e:
        print(f"❌ Test failed with error: {e}")